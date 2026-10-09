import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { registerDocsTools } from './docs.js';
import { registerSheetsTools } from './sheets.js';
import { registerSlidesTools } from './slides.js';

describe('existing collaborative artifact mutations', () => {
  it('requires an outward approval for every existing Docs, Sheets, and Slides mutation', () => {
    const registry = new ToolRegistry();
    const deps = {
      client: {} as never,
      ownerEmail: 'owner@example.test',
      botEmail: 'assistant@example.test',
    };
    registerDocsTools(registry, deps);
    registerSheetsTools(registry, deps);
    registerSlidesTools(registry, deps);
    for (const name of [
      'docs.append',
      'docs.replace_text',
      'sheets.append_rows',
      'sheets.write_rows',
      'slides.append',
    ]) {
      const registered = registry.get(name);
      expect(registered?.tool.risk, name).toBe('approval');
      expect(registered?.flags, name).toMatchObject({
        outwardFacing: true,
        networkEgress: true,
        blanketAllowIneligible: true,
      });
    }
  });
});
