// apps/action/src/index.ts
import { appendFile, readFile } from "node:fs/promises";

// apps/action/src/env.ts
import { env } from "node:process";
function readEnvironment(source = env) {
  const required = (key) => {
    const value = source[key]?.trim();
    if (!value)
      throw new Error(`Missing ${key}.`);
    return value;
  };
  const wait = source.INPUT_WAIT?.trim() || "true";
  const timeoutMinutes = Number(source.INPUT_TIMEOUT?.trim() || "30");
  if (wait !== "true" && wait !== "false")
    throw new Error("The wait input must be true or false.");
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) {
    throw new Error("The timeout input must be between 1 and 60 minutes.");
  }
  if (!source.ACTIONS_ID_TOKEN_REQUEST_URL || !source.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error("Grant id-token: write to this workflow job.");
  }
  return {
    rule: required("INPUT_RULE"),
    url: required("INPUT_URL"),
    sha: source.INPUT_SHA?.trim() ?? "",
    workflowSha: required("GITHUB_SHA"),
    eventName: required("GITHUB_EVENT_NAME"),
    eventPath: source.GITHUB_EVENT_PATH ?? "",
    wait: wait === "true",
    timeoutMinutes,
    apiUrl: source["INPUT_API-URL"]?.trim() || "https://api.rehearsal.dev",
    oidcUrl: required("ACTIONS_ID_TOKEN_REQUEST_URL"),
    oidcRequestToken: required("ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
    outputPath: required("GITHUB_OUTPUT"),
    summaryPath: required("GITHUB_STEP_SUMMARY")
  };
}

// apps/action/src/run.ts
var AUDIENCE = "https://rehearsal.dev";
var PRODUCTION_API = "https://api.rehearsal.dev";
var DEVELOPMENT_API = "https://tunnel-rehearsal-api.rehearsal.dev";
var UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
var SHA = /^[\da-f]{40}$/;
var TERMINAL = ["passed", "failed", "blocked", "cancelled", "could_not_run"];

class ActionFailure extends Error {
}
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ActionFailure("Rehearsal returned an invalid response.");
  return Object.fromEntries(Object.entries(value));
}
function safeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ActionFailure("Provide a complete web address.");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ActionFailure("Use a web address without credentials, a query, or a fragment.");
  }
  return url;
}
async function commit(environment, io) {
  if (environment.sha)
    return environment.sha;
  if (environment.eventName !== "pull_request")
    return environment.workflowSha;
  const event = record(JSON.parse(await io.read(environment.eventPath)));
  const head = record(record(event.pull_request).head);
  if (typeof head.sha !== "string")
    throw new ActionFailure("The pull request has no head commit.");
  return head.sha;
}
function refusal(status) {
  if (status === 401 || status === 403)
    return "Rehearsal could not authorize this request. Check the rule and workflow permissions.";
  if (status === 409)
    return "A newer workflow attempt already started.";
  if (status === 422)
    return "Rehearsal could not start these tests. Check the deployment address and workspace allowance.";
  if (status === 404)
    return "The Rehearsal run is unavailable.";
  if (status === 400)
    return "Check the Action rule, deployment address, and commit inputs.";
  if (status === 429)
    return "Rehearsal is receiving too many requests. Try again shortly.";
  return "Rehearsal could not be reached.";
}

class RequestFailure extends ActionFailure {
  retryable;
  status;
  retryAfterMs;
  constructor(options = {}) {
    super(options.reason ?? refusal(options.status));
    this.status = options.status;
    this.retryable = options.status === undefined || options.status >= 500 || options.status === 429;
    this.retryAfterMs = options.retryAfterMs ?? 0;
  }
}
async function refusalReason(response) {
  if (![400, 401, 403, 404, 409, 422].includes(response.status) || !response.headers.get("content-type")?.includes("application/json")) {
    return;
  }
  try {
    const body = await response.text();
    if (body.length > 1000)
      return;
    const reason = record(JSON.parse(body)).error;
    if (typeof reason === "string" && reason.length > 0 && reason.length <= 240 && ![...reason].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
      return reason;
    }
  } catch {}
}
function retryAfter(response, now) {
  if (response.status !== 429 && response.status !== 503)
    return 0;
  const header = response.headers.get("retry-after")?.trim();
  if (!header)
    return 0;
  if (/^\d+$/.test(header))
    return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
async function requestJson(input) {
  const { io, url, init, deadline } = input;
  let response;
  const timeout = deadline === undefined ? 15000 : Math.max(1, Math.min(15000, deadline - io.now()));
  try {
    response = await io.request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new RequestFailure;
  }
  if (!response.ok) {
    throw new RequestFailure({
      status: response.status,
      reason: input.service === "rehearsal" ? await refusalReason(response) : undefined,
      retryAfterMs: retryAfter(response, io.now())
    });
  }
  try {
    const body = await response.text();
    if (body.length > 1e5)
      throw new ActionFailure("Response too large");
    return record(JSON.parse(body));
  } catch {
    throw new ActionFailure("Rehearsal returned an invalid response.");
  }
}
async function exchangeWithRetries(input) {
  for (let attempt = 0;; attempt += 1) {
    try {
      return await input.operation();
    } catch (error) {
      if (!(error instanceof RequestFailure) || !error.retryable || attempt >= 2)
        throw error;
      await input.io.sleep(Math.min(30000, Math.max(1000 * (attempt + 1), error.retryAfterMs)));
    }
  }
}
function conclusion(status) {
  if (status === "passed")
    return "success";
  if (status === "failed")
    return "failure";
  if (status === "cancelled")
    return "cancelled";
  if (status === "blocked" || status === "could_not_run")
    return "action_required";
  return "pending";
}
function runResult(result, runId) {
  if (result.runId !== runId || typeof result.status !== "string" || !["queued", "running", ...TERMINAL].includes(result.status) || typeof result.total !== "number" || typeof result.passed !== "number" || !Number.isSafeInteger(result.total) || !Number.isSafeInteger(result.passed) || result.total < 0 || result.passed < 0 || result.passed > result.total) {
    throw new ActionFailure("Rehearsal returned an invalid run status.");
  }
  const pending = result.status === "queued" || result.status === "running";
  const verdict = conclusion(result.status);
  if (!pending && (result.conclusion !== verdict || result.status === "passed" && (result.total === 0 || result.total !== result.passed))) {
    throw new ActionFailure("Rehearsal returned inconsistent results.");
  }
  return { status: result.status, total: result.total, passed: result.passed, pending, verdict };
}
async function pollRun(input) {
  const { environment, io } = input;
  const headers = { Authorization: `Bearer ${input.token}` };
  const deadline = io.now() + environment.timeoutMinutes * 60000;
  let lastStatus = "";
  let failures = 0;
  while (io.now() < deadline) {
    let result;
    try {
      result = runResult(await requestJson({ io, url: input.url, init: { headers }, service: "rehearsal", deadline }), input.runId);
    } catch (error) {
      if (error instanceof RequestFailure && (error.status === 401 || error.status === 403))
        throw error;
      failures++;
      if (failures === 1)
        io.log("Rehearsal is temporarily unavailable. Retrying until the wait ends.");
      const backoff = Math.min(1000 * 2 ** Math.min(failures - 1, 5), 30000);
      const wait = Math.max(backoff, error instanceof RequestFailure ? error.retryAfterMs : 0);
      await io.sleep(Math.max(0, Math.min(wait, deadline - io.now())));
      continue;
    }
    if (io.now() >= deadline)
      break;
    failures = 0;
    if (lastStatus !== result.status)
      io.log(`Rehearsal: ${result.status.replaceAll("_", " ")}.`);
    lastStatus = result.status;
    if (!result.pending) {
      await io.append(environment.outputPath, `status=${result.status}
conclusion=${result.verdict}
`);
      await io.append(environment.summaryPath, `${result.passed} of ${result.total} tests passed. Result: ${result.status.replaceAll("_", " ")}.
`);
      return result.status === "passed" ? 0 : 1;
    }
    await io.sleep(Math.min(5000, deadline - io.now()));
  }
  await io.append(environment.outputPath, `status=unknown
conclusion=${failures ? "action_required" : "timed_out"}
`);
  await io.append(environment.summaryPath, `Stopped waiting. The Rehearsal check will carry the result.
`);
  io.log("::error::Timed out waiting for Rehearsal. The run may still be active.");
  return 1;
}
async function runAction(environment, io) {
  let started = false;
  try {
    const target = safeUrl(environment.url);
    const api = safeUrl(environment.apiUrl);
    if (api.protocol !== "https:" || api.pathname !== "/")
      throw new ActionFailure("The API address must be an HTTPS origin.");
    const developmentTunnel = api.origin === DEVELOPMENT_API && target.hostname === new URL(DEVELOPMENT_API).hostname;
    if (target.protocol !== "https:" && !developmentTunnel)
      throw new ActionFailure("Use an HTTPS deployment address.");
    const sha = await commit(environment, io);
    if (!SHA.test(sha) || !SHA.test(environment.workflowSha) || !UUID.test(environment.rule)) {
      throw new ActionFailure("Provide a valid rule ID and full commit SHA.");
    }
    if (!["pull_request", "push"].includes(environment.eventName))
      throw new ActionFailure("Use this Action in a pull_request or push workflow.");
    const oidcUrl = new URL(environment.oidcUrl);
    if (oidcUrl.protocol !== "https:")
      throw new ActionFailure("GitHub did not provide a secure identity endpoint.");
    oidcUrl.searchParams.set("audience", AUDIENCE);
    const identity = await requestJson({ io, url: oidcUrl.toString(), service: "github", init: { headers: { Authorization: `Bearer ${environment.oidcRequestToken}` } } });
    if (typeof identity.value !== "string" || !identity.value)
      throw new ActionFailure("GitHub did not return an identity token.");
    io.mask(identity.value);
    const payload = JSON.stringify({
      identityToken: identity.value,
      rule: environment.rule,
      url: target.toString(),
      sha,
      workflowSha: environment.workflowSha
    });
    const exchange = await exchangeWithRetries({ io, operation: () => requestJson({ io, url: `${api.origin}/ci/github/exchange`, service: "rehearsal", init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    } }) });
    if (typeof exchange.runId !== "string" || !UUID.test(exchange.runId) || typeof exchange.token !== "string" || !exchange.token || typeof exchange.runUrl !== "string") {
      throw new ActionFailure("Rehearsal returned an invalid run.");
    }
    io.mask(exchange.token);
    started = true;
    await io.append(environment.outputPath, `run-id=${exchange.runId}
`);
    const runUrl = safeUrl(exchange.runUrl);
    if (runUrl.protocol !== "https:" && api.origin === PRODUCTION_API)
      throw new ActionFailure("Rehearsal returned an invalid run link.");
    await io.append(environment.outputPath, `run-url=${runUrl.toString()}
`);
    await io.append(environment.summaryPath, `## Rehearsal

[Open the run](${runUrl.toString()})

`);
    io.log(`Run: ${runUrl.toString()}`);
    if (!environment.wait) {
      await io.append(environment.outputPath, `status=queued
conclusion=pending
`);
      await io.append(environment.summaryPath, `Run queued. The Rehearsal check will carry the result.
`);
      io.log("Run queued. The Rehearsal check will carry the result.");
      return 0;
    }
    return await pollRun({ environment, io, url: `${api.origin}/ci/github/runs/${exchange.runId}`, runId: exchange.runId, token: exchange.token });
  } catch (error) {
    const message = error instanceof ActionFailure ? error.message : "The Action could not complete. Check its inputs and the Rehearsal run.";
    const commandMessage = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll(`
`, "%0A");
    io.log(`::error::${commandMessage}`);
    await io.append(environment.outputPath, `status=${started ? "unknown" : "could_not_run"}
conclusion=action_required
`);
    await io.append(environment.summaryPath, `${message}${started ? " The run may still be active." : ""}
`);
    return 1;
  }
}

// apps/action/src/index.ts
var commandValue = (value) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll(`
`, "%0A");
try {
  const environment = readEnvironment();
  process.exitCode = await runAction(environment, {
    request: fetch,
    read: (path) => readFile(path, "utf8"),
    append: (path, content) => appendFile(path, content, "utf8"),
    log: (line) => {
      process.stdout.write(`${line}
`);
    },
    mask: (value) => {
      process.stdout.write(`::add-mask::${commandValue(value)}
`);
    },
    now: Date.now,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  });
} catch {
  process.stderr.write(`::error::Check the Action inputs and grant id-token: write to the job.
`);
  process.exitCode = 1;
}
