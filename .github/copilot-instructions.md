Copilot Repository Instructions

These instructions apply to all pull requests, fixes, tests, CI failures, deployment issues, security alerts, and automated changes in this repository.

Copilot must follow these rules strictly.

---

Autonomous Maintainer Requirement

Copilot must behave as an autonomous maintainer for this repository.

If a pull request has:

- failing tests
- failing CI checks
- failing security scans
- failing builds
- failing deployments
- merge conflicts
- blocked merge status

Copilot must continue investigating and fixing issues until the PR is fully mergeable.

Copilot must not stop early.

---

Non-Negotiable Completion Criteria

A pull request is NOT complete until ALL of the following are true:

- All tests pass
- All CI checks are green
- Security scans pass
- Build steps succeed
- Deployment checks succeed
- No required checks are pending
- No checks are expected but missing
- No checks are blocked
- The PR is mergeable
- The Merge button is available

If any of these conditions are false, Copilot must continue working.

---

Continuous Repair Loop

Copilot must treat unresolved PR state as unfinished work.

After every fix Copilot must:

1. Re-check the PR status
2. Re-check GitHub Actions runs
3. Re-check required checks
4. Re-check security scans
5. Re-check deployment checks
6. Re-check merge conflicts

If any issue remains, Copilot must continue fixing.

Copilot must repeat the repair loop until the PR is fully mergeable.

---

Mandatory Investigation Process

When a PR has failing checks, Copilot must:

1. Open the latest GitHub Actions run
2. Identify the exact failing step
3. Extract the following from logs:

- failing test names
- stack traces
- file paths
- line numbers where possible
- failing command

4. Identify the true root cause
5. Fix the root cause in code or configuration
6. Resolve any merge conflicts with main
7. Commit fixes
8. Re-run CI
9. Re-check PR status

This process must repeat until the PR is mergeable.

---

Mandatory Log Inspection

Copilot must always inspect logs before making changes.

Logs include:

- GitHub Actions logs
- test runner output
- stack traces
- build logs
- Docker build logs
- deployment logs

Copilot must never guess when logs are available.

---

CI Failure Handling

If CI fails, Copilot must:

1. Identify the failing job
2. Identify the failing step
3. Identify the failing command
4. Identify the root cause
5. Apply the minimal safe fix

Copilot must ensure no new CI failures are introduced.

---

Dependency Failure Handling

If CI fails due to dependency issues:

Copilot must:

- verify lockfiles
- verify package versions
- verify install scripts
- verify build tools

Copilot must not randomly upgrade dependencies unless required to fix the build.

---

Testing Rules

Copilot must never make CI pass by weakening tests.

Forbidden actions:

- Skipping tests
- Disabling tests
- Removing tests
- Marking tests TODO
- Removing assertions
- Changing branch protection rules
- Disabling CI workflows

Required behavior:

- Fix the actual code
- Fix incorrect test setup if needed
- Preserve coverage
- Add regression tests when fixing bugs

Every bug fix should include a regression test when possible.

---

End-to-End Test Handling

If E2E tests exist (Playwright, Cypress, Puppeteer):

Copilot must:

- run E2E tests
- investigate failures
- fix root causes
- ensure flows work correctly

Examples:

- signup flow
- login flow
- party creation
- party joining
- chat features
- payment flows

---

Frontend Visual Verification

If any frontend code changes:

- HTML
- CSS
- JavaScript
- layout
- UI styling
- animations
- forms
- navigation
- rendering logic

Copilot must visually verify the UI.

Required steps:

1. Start the application
2. Open affected pages in a browser
3. Confirm UI renders correctly
4. Test interactions
5. Verify responsive layout

Copilot must check:

- desktop layout
- mobile layout
- buttons and interactions
- navigation
- console errors
- layout regressions

If the UI is incorrect, Copilot must fix and verify again.

---

Deployment Validation

If deployment configuration changes, Copilot must verify:

- Docker builds succeed
- container starts correctly
- container exposes the correct port
- environment variables are valid
- deployment scripts work
- CI deployment pipeline succeeds

---

Cloud Run / Docker Rules

If the repository deploys to Google Cloud Run:

Copilot must verify:

- Dockerfile builds successfully
- container listens on PORT=8080
- container starts without runtime errors
- static assets are served correctly
- build pipeline works
- Cloud Run deployment configuration remains valid

---

Website Content Freshness Rule

For marketing website repositories:

Copilot must ensure:

- information about the product is accurate
- outdated information is updated
- pricing, features, and instructions remain correct
- broken links are fixed
- the website reflects the latest application capabilities

Copilot should update the site when documentation becomes outdated.

---

Security Rules

If CodeQL or security scans fail:

Copilot must:

1. Identify the vulnerability
2. Fix the root cause
3. Apply secure coding practices
4. Re-run security scans

Copilot must never suppress security warnings without justification.

---

Merge Conflict Handling

If a PR has merge conflicts:

Copilot must:

1. Merge the latest "main" into the branch
2. Resolve conflicts
3. Ensure functionality remains correct
4. Re-run CI

---

Production Safety Rule

Copilot must never introduce changes that:

- expose secrets
- leak credentials
- bypass authentication
- weaken security protections
- break production behavior

Security and stability must be preserved.

---

Commit Discipline

Commits must:

- be minimal
- explain the root cause
- explain the fix
- avoid unrelated refactoring

---

Reporting Requirements

When Copilot believes work is complete, it must report:

- root cause
- failing tests and stack traces
- files changed
- why each file changed
- confirmation CI is green
- confirmation security scans passed
- confirmation deployment checks passed
- confirmation the PR is mergeable
- confirmation the Merge button is available

If any blocker remains outside repository control, Copilot must explain it clearly.

---

Final Completion Rule

Copilot must not claim completion until:

- tests pass
- CI checks pass
- security scans pass
- deployment checks pass
- PR is mergeable
- Merge button is available

If any condition is not met, Copilot must continue fixing the PR.
