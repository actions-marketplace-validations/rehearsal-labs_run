# Rehearsal

Run your saved Rehearsal tests against a deployment from a GitHub workflow, and see the result as a check on the commit.

[Rehearsal](https://rehearsal.dev) explores your web app in real browsers, finds the bugs and turns what works into tests. This Action runs those tests on the address your workflow just deployed, such as a preview of a pull request, and fails the step when a test fails. It signs in with GitHub's own identity for the workflow, so you store no Rehearsal secret in your repository.

## Before you start

You need three things from Rehearsal:

1. A Rehearsal project with saved tests for your app.
2. The Rehearsal GitHub App connected to this repository. In Rehearsal, open **Settings**, then **Repository**.
3. A rule that takes its address from GitHub Actions. In Rehearsal, open **Pull requests**, then **Rules**, add a rule and choose **An address from GitHub Actions**. Copy the rule's ID.

## Usage

Add the step to the job that deploys your app, after the deployment answers:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  # Your deployment step comes first, with any permissions it needs.
  - uses: rehearsal-labs/run@v1
    with:
      rule: YOUR_RULE_ID
      url: ${{ steps.deploy.outputs.url }}
```

`id-token: write` lets GitHub hand the step a short-lived identity, which Rehearsal checks against the repository the rule belongs to. `contents: read` keeps your checkout working once you set permissions for the job.

The address must use HTTPS and sit on the rule's website host or one of its subdomains. For preview hosts such as Vercel's, add patterns to the rule, such as `*-acme.vercel.app`. A pattern has at most one wildcard, in the first part of the host.

When the step runs, Rehearsal starts the rule's tests at that address and the step waits for the result. A passed run passes the step. A failed, blocked or cancelled run fails it, and so does a run Rehearsal could not finish. The run also appears as a check on the commit, which you can require before merging.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `rule` | required | The ID of the rule in Rehearsal. |
| `url` | required | The deployed address to test: HTTPS, on a host the rule allows, with no credentials, query or fragment. |
| `sha` | the pull request's head, or `GITHUB_SHA` | The full commit the address serves. Rehearsal checks it against GitHub. |
| `wait` | `true` | Wait for the tests. With `false`, the step passes once the run starts and the check on the commit carries the result. |
| `timeout` | `30` | How many minutes to wait, from 1 to 60. |
| `api-url` | `https://api.rehearsal.dev` | Only for a development server of Rehearsal. |

## Outputs

| Output | What it holds |
| --- | --- |
| `run-id` | The Rehearsal run's ID. |
| `run-url` | A link to the run in Rehearsal. The job summary links to it too. |
| `status` | `queued`, `running`, `passed`, `failed`, `blocked`, `cancelled`, `could_not_run`, or `unknown` when the result could not be read. |
| `conclusion` | `success`, `failure`, `action_required`, `cancelled`, `timed_out` or `pending`. |

When the wait ends before the run does, `conclusion` is `timed_out` and the check on the commit still gets the result.

## Good to know

- The Action works in `push` workflows and in `pull_request` workflows from branches of the same repository. Pull requests from forks, merge queues and `pull_request_target` are not supported.
- Running the workflow again starts a new run and cancels an older one for the same rule that has not finished.
- Skipping the step leaves the commit without a Rehearsal check, so a pull request that requires one keeps waiting.

## Learn more

[Rules for pull requests and deployments](https://rehearsal.dev/docs/github/rules) in Rehearsal's docs covers rules, addresses and checks in full.

## License

[Apache-2.0](LICENSE)
