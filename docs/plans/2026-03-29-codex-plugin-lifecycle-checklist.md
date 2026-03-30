# Codex Plugin Lifecycle Checklist

- [x] Align workflow marketplace plugin source-path validation with Codex semantics.
- [x] Sync generated Codex app-server protocol snapshot to latest upstream.
- [ ] Separate workflow plugin identity from workflow plugin filesystem assets.
- [ ] Introduce a Codex-native plugin lifecycle service around `plugin/list`, `plugin/read`, `plugin/install`, and `plugin/uninstall`.
- [ ] Wire Codex workflow sessions to ensure workflow plugins are installed before thread start.
- [ ] Keep Claude on `--plugin-dir` semantics without regressing existing plugin behavior.
- [ ] Stop using workflow plugin `skills/` roots for Codex-installed plugins once plugin-native skill metadata is verified.
- [ ] Stop merging plugin `.mcp.json` for Codex-installed plugins once plugin-native MCP wiring is verified.
- [ ] Split `registerPlugins()` responsibilities into explicit Claude/local-only services.
- [ ] Add diagnostics comparing Athena-local plugin resolution to Codex-native plugin state.
- [ ] Add integration tests for Codex workflow plugin installation and session startup.
- [ ] Remove Codex-only filesystem plugin shims after rollout verification.
