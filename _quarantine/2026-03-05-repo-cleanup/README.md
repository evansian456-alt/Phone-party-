# Repository Cleanup Quarantine — 2026-03-05

This folder contains files that were moved out of the root during the codebase cleanup.
They are preserved here so they can be reviewed and restored if needed.

## Files Moved to `docs/`

All markdown files from the root (except `README.md`, `CONTRIBUTING.md`, `FAQ.md`) were
moved to the `docs/` directory to reduce root-level clutter.

| Original File Path | Reason For Move | Date Moved | How To Restore |
|---|---|---|---|
| `ACTION_PLAN.md` | Implementation notes, not a root readme | 2026-03-05 | `git mv docs/ACTION_PLAN.md .` |
| `AMPSYNC_QUICK_REF.md` | Feature quick-reference, belongs in docs | 2026-03-05 | `git mv docs/AMPSYNC_QUICK_REF.md .` |
| `ANDROID_*.md` (13 files) | Android audit/deployment docs, belongs in docs | 2026-03-05 | `git mv docs/ANDROID_*.md .` |
| `ARCHITECTURE_*.md` | Architecture docs, belongs in docs | 2026-03-05 | `git mv docs/ARCHITECTURE_*.md .` |
| `AUDIT_COMPLETE_SUMMARY.md` | Audit report, belongs in docs | 2026-03-05 | `git mv docs/AUDIT_COMPLETE_SUMMARY.md .` |
| `CAPABILITY_MAP.md` | Feature map, belongs in docs | 2026-03-05 | `git mv docs/CAPABILITY_MAP.md .` |
| `CLEANUP_IMPLEMENTATION_GUIDE.md` | Cleanup guide, belongs in docs | 2026-03-05 | `git mv docs/CLEANUP_IMPLEMENTATION_GUIDE.md .` |
| `CODEBASE_AUDIT_REPORT.md` | Audit report, belongs in docs | 2026-03-05 | `git mv docs/CODEBASE_AUDIT_REPORT.md .` |
| `CODE_REVIEW_FIXES.md` | Review notes, belongs in docs | 2026-03-05 | `git mv docs/CODE_REVIEW_FIXES.md .` |
| `COMPREHENSIVE_E2E_*.md` | Test reports, belongs in docs | 2026-03-05 | `git mv docs/COMPREHENSIVE_E2E_*.md .` |
| `CONFLICTS_RESOLVED.md` | Merge history, belongs in docs | 2026-03-05 | `git mv docs/CONFLICTS_RESOLVED.md .` |
| `CREATE_PARTY_*.md` | Implementation notes, belongs in docs | 2026-03-05 | `git mv docs/CREATE_PARTY_*.md .` |
| `DEPLOYMENT_AUTOMATION_GUIDE.md` | Deployment guide, belongs in docs | 2026-03-05 | `git mv docs/DEPLOYMENT_AUTOMATION_GUIDE.md .` |
| `DEPLOYMENT_READINESS_CHECKLIST.md` | Deployment checklist, belongs in docs | 2026-03-05 | `git mv docs/DEPLOYMENT_READINESS_CHECKLIST.md .` |
| `DIRECT_CDN_PLAYBACK_IMPLEMENTATION.md` | CDN implementation notes, belongs in docs | 2026-03-05 | `git mv docs/DIRECT_CDN_PLAYBACK_IMPLEMENTATION.md .` |
| `EMOJI_AUDIT_COMPLETE.md` | Audit report, belongs in docs | 2026-03-05 | `git mv docs/EMOJI_AUDIT_COMPLETE.md .` |
| `EVENT_REPLAY_IMPLEMENTATION_SUMMARY.md` | Feature summary, belongs in docs | 2026-03-05 | `git mv docs/EVENT_REPLAY_IMPLEMENTATION_SUMMARY.md .` |
| `FINAL_DELIVERY_REPORT.md` | Delivery report, belongs in docs | 2026-03-05 | `git mv docs/FINAL_DELIVERY_REPORT.md .` |
| `GUEST_REACTIONS_FIX.md` | Bug fix notes, belongs in docs | 2026-03-05 | `git mv docs/GUEST_REACTIONS_FIX.md .` |
| `HOST_FAILOVER_*.md` | Feature docs, belongs in docs | 2026-03-05 | `git mv docs/HOST_FAILOVER_*.md .` |
| `IMPLEMENTATION_*.md` (multiple) | Implementation notes, belongs in docs | 2026-03-05 | `git mv docs/IMPLEMENTATION_*.md .` |
| `IMPROVEMENT_*.md` | Improvement guides, belongs in docs | 2026-03-05 | `git mv docs/IMPROVEMENT_*.md .` |
| `LEADERBOARD_PRO_MONTHLY_FILTER.md` | Feature notes, belongs in docs | 2026-03-05 | `git mv docs/LEADERBOARD_PRO_MONTHLY_FILTER.md .` |
| `MANUAL_TEST_PLAN_UPLOAD.md` | Test plan, belongs in docs | 2026-03-05 | `git mv docs/MANUAL_TEST_PLAN_UPLOAD.md .` |
| `MERGE_RESOLUTION_*.md` | Merge history, belongs in docs | 2026-03-05 | `git mv docs/MERGE_RESOLUTION_*.md .` |
| `MISSING_FEATURES.md` | Roadmap notes, belongs in docs | 2026-03-05 | `git mv docs/MISSING_FEATURES.md .` |
| `MUSIC_SYNC_*.md` | Sync feature docs, belongs in docs | 2026-03-05 | `git mv docs/MUSIC_SYNC_*.md .` |
| `NEW_DOCS_README.md` | Docs index, belongs in docs | 2026-03-05 | `git mv docs/NEW_DOCS_README.md .` |
| `NEXT_STEPS.md` | Roadmap, belongs in docs | 2026-03-05 | `git mv docs/NEXT_STEPS.md .` |
| `OBSERVABILITY_IMPLEMENTATION.md` | Feature notes, belongs in docs | 2026-03-05 | `git mv docs/OBSERVABILITY_IMPLEMENTATION.md .` |
| `PAYMENT_INTEGRATION_GUIDE.md` | Payment integration, belongs in docs | 2026-03-05 | `git mv docs/PAYMENT_INTEGRATION_GUIDE.md .` |
| `PHASE_8_9_10_SUMMARY.md` | Phase summary, belongs in docs | 2026-03-05 | `git mv docs/PHASE_8_9_10_SUMMARY.md .` |
| `PRODUCTION_UPGRADE_*.md` | Production docs, belongs in docs | 2026-03-05 | `git mv docs/PRODUCTION_UPGRADE_*.md .` |
| `PR_*.md` (multiple) | PR management, belongs in docs | 2026-03-05 | `git mv docs/PR_*.md .` |
| `PWA_*.md` | PWA docs, belongs in docs | 2026-03-05 | `git mv docs/PWA_*.md .` |
| `QUICK_*.md` | Quick reference, belongs in docs | 2026-03-05 | `git mv docs/QUICK_*.md .` |
| `RAILWAY_*.md` | Deployment docs, belongs in docs | 2026-03-05 | `git mv docs/RAILWAY_*.md .` |
| `README_ANDROID_AUDIT.md` | Android audit readme, belongs in docs | 2026-03-05 | `git mv docs/README_ANDROID_AUDIT.md .` |
| `READY_GATING_*.md` | Feature docs, belongs in docs | 2026-03-05 | `git mv docs/READY_GATING_*.md .` |
| `ROADMAP_VISUAL.md` | Roadmap, belongs in docs | 2026-03-05 | `git mv docs/ROADMAP_VISUAL.md .` |
| `ROLLBACK_UPLOAD_TRACK.md` | Rollback notes, belongs in docs | 2026-03-05 | `git mv docs/ROLLBACK_UPLOAD_TRACK.md .` |
| `SECURITY_*.md` (multiple) | Security summaries, belongs in docs | 2026-03-05 | `git mv docs/SECURITY_*.md .` |
| `SONG_SYNC_IMPROVEMENTS.md` | Feature notes, belongs in docs | 2026-03-05 | `git mv docs/SONG_SYNC_IMPROVEMENTS.md .` |
| `START_HERE_ANDROID.md` | Android guide, belongs in docs | 2026-03-05 | `git mv docs/START_HERE_ANDROID.md .` |
| `SYNCSPEAKER_AMPSYNC_DOCS.md` | Feature docs, belongs in docs | 2026-03-05 | `git mv docs/SYNCSPEAKER_AMPSYNC_DOCS.md .` |
| `SYNC_*.md` | Sync docs, belongs in docs | 2026-03-05 | `git mv docs/SYNC_*.md .` |
| `TASK_*.md` (multiple) | Task completion notes, belongs in docs | 2026-03-05 | `git mv docs/TASK_*.md .` |
| `TECHNICAL_AUDIT_MULTI_DEVICE_SYNC.md` | Audit report, belongs in docs | 2026-03-05 | `git mv docs/TECHNICAL_AUDIT_MULTI_DEVICE_SYNC.md .` |
| `TEST_COVERAGE_MAP.md` | Test coverage, belongs in docs | 2026-03-05 | `git mv docs/TEST_COVERAGE_MAP.md .` |
| `TEST_EXECUTION_SUMMARY.md` | Test results, belongs in docs | 2026-03-05 | `git mv docs/TEST_EXECUTION_SUMMARY.md .` |
| `VERIFICATION_QUICK_START.md` | Verification guide, belongs in docs | 2026-03-05 | `git mv docs/VERIFICATION_QUICK_START.md .` |
| `VISUAL_SUMMARY.md` | Visual summary, belongs in docs | 2026-03-05 | `git mv docs/VISUAL_SUMMARY.md .` |
| `WHY_85_PERCENT_ANDROID_READY.md` | Android readiness, belongs in docs | 2026-03-05 | `git mv docs/WHY_85_PERCENT_ANDROID_READY.md .` |

## Shell Scripts Moved to `scripts/`

| Original File Path | Reason For Move | Date Moved | How To Restore |
|---|---|---|---|
| `check-all-prs.sh` | Utility script, belongs in scripts/ | 2026-03-05 | `git mv scripts/check-all-prs.sh .` |
| `resolve-pr-conflicts.sh` | Utility script, belongs in scripts/ | 2026-03-05 | `git mv scripts/resolve-pr-conflicts.sh .` |
| `run-e2e-tests.sh` | Utility script, belongs in scripts/ | 2026-03-05 | `git mv scripts/run-e2e-tests.sh .` |

## Notes

- No source code or test files were deleted
- All moves are tracked by git (`git mv`) so history is preserved
- The application runtime is unaffected by these moves
- Tests remain in their original locations and still pass
