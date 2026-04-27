/**
 * @module        frontmatter.test
 * @description   Wiki frontmatter 解析、序列化、校验测试
 */
import { describe, expect, it } from 'vitest';
import {
  FrontmatterError,
  parseFrontmatter,
  serializeFrontmatter,
  tryParseFrontmatter,
  validateFrontmatter,
} from './frontmatter.js';
import type { Frontmatter } from './types.js';

const minimalLessonFm: Frontmatter = {
  type: 'lesson',
  title: 'Stop Hook Race',
  created: '2026-04-27',
  updated: '2026-04-27',
  tags: ['pipeline'],
  status: 'developing',
  related: ['[[modules/PipelineService]]'],
  sources: [{ commit: 'abc123' }],
  generated: 'manual',
  severity: 'major',
};

describe('parseFrontmatter', () => {
  it('parses minimal valid frontmatter + body', () => {
    const content = `---
type: lesson
title: Stop Hook Race
created: 2026-04-27
updated: 2026-04-27
tags: [pipeline]
status: developing
related: ['[[modules/PipelineService]]']
sources:
  - commit: abc123
generated: manual
severity: major
---

## TL;DR
Race between Stop hook and ACP completion.
`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.type).toBe('lesson');
    expect(frontmatter.title).toBe('Stop Hook Race');
    if (frontmatter.type === 'lesson') {
      expect(frontmatter.severity).toBe('major');
    }
    expect(body).toContain('## TL;DR');
    expect(body).toContain('Race between Stop hook');
  });

  it('throws when no frontmatter block', () => {
    expect(() => parseFrontmatter('# Just a heading\n\nNo frontmatter.')).toThrow(
      FrontmatterError,
    );
  });

  it('throws on YAML syntax error', () => {
    const content = `---
type: lesson
title: [bad: yaml
---

body
`;
    expect(() => parseFrontmatter(content)).toThrow(FrontmatterError);
  });

  it('throws on schema validation failure (unknown type)', () => {
    const content = `---
type: bogus
title: Foo
created: 2026-04-27
updated: 2026-04-27
---

body
`;
    expect(() => parseFrontmatter(content)).toThrow(FrontmatterError);
  });

  it('throws when missing required field for type', () => {
    // module 必须有 module_path
    const content = `---
type: module
title: Foo
created: 2026-04-27
updated: 2026-04-27
---

body
`;
    expect(() => parseFrontmatter(content)).toThrow(FrontmatterError);
  });

  it('rejects bad date format', () => {
    const content = `---
type: lesson
title: Foo
created: 2026/04/27
updated: 2026-04-27
---
body
`;
    expect(() => parseFrontmatter(content)).toThrow(FrontmatterError);
  });

  it('rejects invalid wikilink format in related', () => {
    const content = `---
type: lesson
title: Foo
created: 2026-04-27
updated: 2026-04-27
related:
  - "not a wikilink"
---
body
`;
    expect(() => parseFrontmatter(content)).toThrow(FrontmatterError);
  });

  it('coerces string source ref to {path}', () => {
    const content = `---
type: source
title: Some PDF
created: 2026-04-27
updated: 2026-04-27
source_type: pdf
original_path: .raw/pdfs/foo.pdf
sources:
  - .raw/pdfs/foo.pdf
---
body
`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.sources[0]).toEqual({ path: '.raw/pdfs/foo.pdf' });
  });

  it('preserves body whitespace inside (just trims leading newlines)', () => {
    const content = `---
type: lesson
title: Foo
created: 2026-04-27
updated: 2026-04-27
severity: minor
---


body line 1


body line 2
`;
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/^body line 1\n\n\nbody line 2/);
  });
});

describe('tryParseFrontmatter', () => {
  it('returns ok=true on success', () => {
    const content = `---
type: lesson
title: Foo
created: 2026-04-27
updated: 2026-04-27
severity: major
---

body
`;
    const r = tryParseFrontmatter(content);
    expect(r.ok).toBe(true);
  });

  it('returns ok=false with error on failure (no throw)', () => {
    const r = tryParseFrontmatter('garbage with no frontmatter');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(FrontmatterError);
    }
  });
});

describe('serializeFrontmatter (round-trip)', () => {
  it('round-trips minimal lesson page', () => {
    const out = serializeFrontmatter(minimalLessonFm, '## TL;DR\nbody\n');
    const reparsed = parseFrontmatter(out);
    expect(reparsed.frontmatter.type).toBe('lesson');
    expect(reparsed.frontmatter.title).toBe('Stop Hook Race');
    expect(reparsed.body).toContain('## TL;DR');
  });

  it('output starts with --- and ends with newline', () => {
    const out = serializeFrontmatter(minimalLessonFm, 'body');
    expect(out.startsWith('---\n')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('preserves wikilinks without auto-wrapping (lineWidth=0)', () => {
    const fm: Frontmatter = {
      ...minimalLessonFm,
      related: ['[[modules/SomeReallyLongModuleNameThatWouldOtherwiseWrap]]'],
    };
    const out = serializeFrontmatter(fm, 'body');
    // 单行不被切断
    const yamlBlock = out.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const relatedLine = yamlBlock.split('\n').find((l) => l.includes('SomeReallyLongModule'));
    expect(relatedLine).toBeDefined();
    expect(relatedLine).toContain('[[modules/SomeReallyLongModuleNameThatWouldOtherwiseWrap]]');
  });
});

describe('validateFrontmatter', () => {
  it('passes valid lesson', () => {
    const r = validateFrontmatter(minimalLessonFm);
    expect(r.ok).toBe(true);
  });

  it('rejects missing required field', () => {
    const bad = { type: 'lesson', title: 'X' };
    const r = validateFrontmatter(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(FrontmatterError);
      expect(r.error.issues?.length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown type', () => {
    const r = validateFrontmatter({ type: 'unknown', title: 'X' });
    expect(r.ok).toBe(false);
  });
});
