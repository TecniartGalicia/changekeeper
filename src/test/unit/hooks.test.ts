import * as assert from 'assert';
import { detectAgent, parseHookPayload, pickFolder } from '../../core/hooks/events';
import { addChangeKeeperHooks, hookUrl, installedHooks, isOurHook, removeChangeKeeperHooks, serialiseSettings } from '../../core/hooks/settingsEdit';

describe('hooks: settings editing (Pro)', () => {
  const foreign = { type: 'command', command: 'echo hi', timeout: 5 };
  it('adds our http hooks idempotently and preserves foreign hooks and unrelated keys', () => {
    const settings = { permissions: { allow: ['Bash(git *)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [foreign] }], PostToolUse: [{ matcher: 'Edit', hooks: [foreign] }] } };
    const a = addChangeKeeperHooks(settings, 47391, 'tok');
    assert.ok(a.changed);
    assert.deepStrictEqual(settings.hooks.PostToolUse.length, 1, 'input untouched (new object returned)');
    const ours = installedHooks(a.next);
    assert.deepStrictEqual(ours.map((x) => x.event).sort(), ['PostToolUse', 'SessionEnd', 'SessionStart', 'Stop']);
    assert.ok(ours.every((x) => x.port === 47391));
    assert.deepStrictEqual(a.next.permissions, settings.permissions);
    assert.deepStrictEqual(a.next.hooks!.PreToolUse, [{ matcher: 'Bash', hooks: [foreign] }], 'foreign event untouched');
    assert.deepStrictEqual(a.next.hooks!.PostToolUse[0], { matcher: 'Edit', hooks: [foreign] }, 'foreign PostToolUse group first and intact');
    const post = a.next.hooks!.PostToolUse[1];
    assert.strictEqual(post.matcher, 'Edit|Write|NotebookEdit');
    assert.deepStrictEqual(post.hooks[0], { type: 'http', url: hookUrl(47391), headers: { 'X-CK-Token': 'tok' }, timeout: 3, statusMessage: 'ChangeKeeper' });
    assert.strictEqual(a.next.hooks!.SessionStart[0].matcher, 'startup|resume|clear|compact|fork');
    // second install with a new port replaces ours only
    const b = addChangeKeeperHooks(a.next, 47400, 'tok2');
    assert.strictEqual(installedHooks(b.next).length, 4);
    assert.ok(installedHooks(b.next).every((x) => x.port === 47400));
    assert.strictEqual(b.next.hooks!.PostToolUse.length, 2);
    assert.strictEqual(serialiseSettings(b.next).endsWith('}\n'), true);
  });
  it('removes only ours, dropping empty groups and keys', () => {
    const settings = { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [foreign] }] } };
    const a = addChangeKeeperHooks(settings, 47391, 'tok');
    const r = removeChangeKeeperHooks(a.next);
    assert.ok(r.changed);
    assert.deepStrictEqual(r.next, settings);
    const r2 = removeChangeKeeperHooks(addChangeKeeperHooks({}, 1, 't').next);
    assert.deepStrictEqual(r2.next, {});
    assert.strictEqual(removeChangeKeeperHooks({ hooks: { PostToolUse: [{ hooks: [foreign] }] } }).changed, false);
  });
  it('keeps an existing allowedHttpHookUrls allowlist in sync', () => {
    const a = addChangeKeeperHooks({ allowedHttpHookUrls: ['https://example.test/x'] }, 5, 't');
    assert.deepStrictEqual(a.next.allowedHttpHookUrls, ['https://example.test/x', hookUrl(5)]);
    const r = removeChangeKeeperHooks(a.next);
    assert.deepStrictEqual(r.next.allowedHttpHookUrls, ['https://example.test/x']);
    assert.strictEqual(addChangeKeeperHooks({}, 5, 't').next.allowedHttpHookUrls, undefined, 'no allowlist is created when the user has none');
    assert.ok(isOurHook({ type: 'http', url: 'http://127.0.0.1:47391/hook' }));
    assert.ok(!isOurHook({ type: 'http', url: 'http://evil.test/hook' }));
    assert.ok(!isOurHook({ type: 'command', command: 'curl http://127.0.0.1:47391/hook' }));
  });
});

describe('hooks: payloads and routing', () => {
  it('parses Claude Code payloads and detects the agent', () => {
    const e = parseHookPayload({ session_id: 's', transcript_path: 'C:\\Users\\x\\.claude\\projects\\p\\t.jsonl', cwd: 'C:\\repo', permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'C:\\repo\\src\\a.ts', old_string: 'a', new_string: 'b' }, tool_response: {} })!;
    assert.strictEqual(e.kind, 'tool-done');
    assert.strictEqual(e.agent, 'claude-code');
    assert.strictEqual(e.filePath, 'C:\\repo\\src\\a.ts');
    assert.strictEqual(e.toolName, 'Edit');
    assert.strictEqual(parseHookPayload({ hook_event_name: 'SessionStart', cwd: '/w', transcript_path: '/home/u/.claude/x' })!.kind, 'session-start');
    assert.strictEqual(parseHookPayload({ hook_event_name: 'Stop' })!.kind, 'stop');
    assert.strictEqual(parseHookPayload({ hook_event_name: 'SessionEnd' })!.kind, 'session-end');
    assert.strictEqual(parseHookPayload({ hook_event_name: 'Whatever' })!.kind, 'other');
    assert.strictEqual(parseHookPayload('junk'), undefined);
    assert.strictEqual(detectAgent({ transcript_path: '/home/u/.copilot/session.json' }), 'copilot');
    assert.strictEqual(detectAgent({}), 'agent');
  });
  it('picks the longest folder containing the path (case-insensitive on Windows/macOS)', () => {
    const folders = ['C:\\Repos\\a', 'C:\\Repos\\a\\packages\\web', 'D:\\other'];
    assert.strictEqual(pickFolder('c:/repos/a/packages/web/src/x.ts', folders, 'win32'), 'C:\\Repos\\a\\packages\\web');
    assert.strictEqual(pickFolder('C:\\Repos\\a\\README.md', folders, 'win32'), 'C:\\Repos\\a');
    assert.strictEqual(pickFolder('C:\\Repos\\ab\\x', folders, 'win32'), undefined, 'prefix must end at a separator');
    assert.strictEqual(pickFolder('/home/u/proj/x', ['/home/u/proj', '/home/u/PROJ'], 'linux'), '/home/u/proj');
  });
});
