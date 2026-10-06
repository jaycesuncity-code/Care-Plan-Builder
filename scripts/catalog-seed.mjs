// Build/test tooling only: extract the current literal seed strings without running page scripts.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
export function readBuilderSeed() {
  const html = readFileSync(new URL('../public/careplan-builder/index.html', import.meta.url), 'utf8');
  function array(name) {
    const match = html.match(new RegExp('var ' + name + ' = (\\[[\\s\\S]*?\\n  \\]);'));
    if (!match) throw new Error('Missing Builder seed array');
    return JSON.parse(JSON.stringify(runInNewContext('(' + match[1] + ')', {}, { timeout: 1000 })));
  }
  return { plans: array('PLANS'), addons: array('ADDON_GROUPS').flatMap(group => group.items) };
}
