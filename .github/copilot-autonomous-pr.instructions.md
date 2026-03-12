# Copilot Repository Instructions

These instructions define how Copilot must behave when working in this repository.

Copilot must follow these rules strictly.

---

# PRIMARY OBJECTIVE

Copilot must continue working on a pull request until the PR is fully mergeable.

A pull request is considered complete ONLY when ALL of the following are true:

• all unit tests pass  
• all integration tests pass  
• all end-to-end tests pass  
• CI / Lint / Build / Test workflow is green  
• CodeQL and security scans pass  
• all required GitHub checks are green  
• no checks are pending, expected, or missing  
• the PR has no merge conflicts  
• GitHub reports the PR as mergeable  
• the Merge button is available

Copilot must NEVER report completion until all conditions above are satisfied.

---

# REQUIRED PROCESS

Whenever Copilot works on a pull request it must follow this exact workflow.

## 1. Check merge conflicts FIRST

Before investigating CI failures, Copilot must check whether the pull request has merge conflicts with the base branch.

If merge conflicts exist:

• resolve the conflicts with the base branch  
• ensure the resulting code compiles  
• commit the conflict resolution  
• push the changes  
• wait for CI to rerun  
• continue the investigation process

Copilot must never report completion while conflicts exist.

---

## 2. Inspect CI failures

Copilot must open the latest GitHub Actions run for the pull request.

Copilot must identify:

• the failing workflow  
• the failing job  
• the failing step  
• failing tests  
• stack traces  
• file paths  
• line numbers

Copilot must determine the real root cause using logs and source code.

---

## 3. Fix the root cause

Copilot must fix the actual code or configuration causing the failure.

Copilot must NOT:

• guess when logs can be inspected  
• suppress legitimate failures  
• disable or weaken tests

---

## 4. Push the fix

After implementing the fix:

• commit the changes  
• push the branch  
• allow GitHub Actions to rerun

---

## 5. Verify PR status

After CI runs again, Copilot must check:

• CI status  
• required checks  
• test results  
• CodeQL results  
• merge conflicts  
• PR mergeability

If anything is still failing, pending, blocked, or missing, Copilot must repeat the investigation process.

This loop must continue until the PR becomes mergeable.

---

# CI WORKFLOWS

The repository uses GitHub Actions.

Common required checks include:

• CI / Lint, Build & Test  
• CodeQL / Code scanning  
• App Health Monitor  
• Docker build workflows

Copilot must ensure that all workflows:

• run successfully  
• report status checks  
• complete without skipped required jobs.

If a workflow fails due to configuration issues, Copilot must fix the workflow file.

---

# SECURITY RULES

Copilot must never suppress security findings.

If CodeQL or security scanning reports alerts:

• identify the exact vulnerability  
• fix the underlying code  
• preserve existing behavior where possible

Copilot must not disable CodeQL scanning or ignore alerts.

---

# TEST RULES

Copilot must NOT:

• remove tests  
• disable tests  
• weaken tests  
• skip tests

If tests fail, Copilot must fix the implementation code.

---

# MERGE CONFLICT RULES

Copilot must always check whether the pull request has merge conflicts.

If conflicts exist:

• resolve them immediately  
• ensure the resulting code builds and tests pass  
• push the resolution before continuing

Copilot must never claim completion while conflicts exist.

---

# DEPLOYMENT RULES

If deployment files are modified (for example Dockerfile, nginx.conf, cloudbuild.yaml):

Copilot must verify that:

• Docker images build successfully  
• container ports match runtime configuration  
• Cloud Run configuration is correct  
• health checks return HTTP 200  
• static files and SPA routing function correctly

---

# FORBIDDEN ACTIONS

Copilot must NEVER:

• disable tests  
• weaken CI checks  
• suppress security alerts  
• bypass repository rules  
• mark a PR complete when it is not mergeable

---

# FINAL REQUIREMENT

Copilot must behave like an autonomous maintainer.

The task is not complete until the pull request is safe to merge and the Merge button is available.
