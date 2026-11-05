# Project DND

Web-based D&D game: 2.5D (2D pixel chibi sprites on low-poly 3D isometric scenes), 90s anime style.
Assets are generated with the parent `stable-diffusion-webui` (NoobAI-XL eps 1.1 + ElinSpriteNoobLocon).

## Workflow (skills per stage)

1. **Designing a game system** → run the `grill-me` / `grilling` skill.
   - The user explains the system idea; interview them in rounds until the design tree is empty.
   - Once the user confirms shared understanding, write the spec to `docs/specs/<system-name>.md`
     (goal, player-facing behavior, rules/formulas, data model, edge cases, open questions, out of scope).
   - Don't write code during this stage.
2. **Writing code** → follow the `karpathy-guidelines` skill before and while coding
   (state assumptions, simplest solution, surgical changes, verifiable success criteria).
   Implement against the spec in `docs/specs/` when one exists.
3. **Code finished** → run the `scrutinize` skill on the change before calling it done,
   then report findings and the verdict to the user.
