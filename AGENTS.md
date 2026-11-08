# Agent instructions

1. Keep documentation as short as possible without losing meaning. Remove repetition; preserve decisions, requirements, caveats, and acceptance criteria. Link to details instead of duplicating them.
2. PamatCAD is the active project; `../workingcad/` is reference-only and will be removed later. Consult it for earlier work, but modify, migrate, or delete legacy files only when explicitly requested. Read `README.md` and applicable project documentation before implementation.
3. For feature work, follow [From feature spec to verified operation](doc/dev/command.md). Before coding, resolve missing information and implementation alternatives. Clarify obvious mistakes or better approaches; present a step-by-step plan with relevant code snippets and obtain confirmation. Follow the confirmed plan and any additional instructions.
4. Search for existing or similar code before making changes. Reuse it where appropriate; add entities, classes, functions, templates, or other abstractions only when necessary and approved.
5. Preserve functionality outside the requested scope. Do not disable or alter unrelated behavior without explicit authorization.
6. Organize code by responsibility and feature: core/model, UI, sketches, CAM, and shared services such as logging. Keep the structure suitable for many actions and future features.
7. Keep custom icons as editable SVG files in a dedicated icons directory and import them; do not embed icon geometry in components. The reference project's icon directory is `apps/editor/src/icons/`.
8. Keep builds reproducible and setup minimal. Prefer standard build tools over ad-hoc build scripts; minimize manual library, SDK, and compiler-flag setup. Document only the necessary build steps.
9. Validate modeling changes with shape-level regression and repeatability tests. Save files also serve as test scenarios: exercise the CLI with the same command format used by the API and application, without a separate test-only document format.
10. Keep edits narrowly scoped. Ask before rewording user-authored material unless rewriting it is the task.