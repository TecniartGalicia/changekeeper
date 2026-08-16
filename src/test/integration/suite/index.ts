import * as path from 'path';
import Mocha from 'mocha';
import { globSync } from 'glob';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 20000 });
  const testsRoot = path.resolve(__dirname);
  for (const f of globSync('**/*.test.js', { cwd: testsRoot })) mocha.addFile(path.resolve(testsRoot, f));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} tests failed.`)) : resolve()));
  });
}
