/** Entry point handed to @vscode/test-electron: plays the demo script instead of a test suite. */
export async function run(): Promise<void> {
  const { run: play } = await import('./demo.js');
  await play();
}
