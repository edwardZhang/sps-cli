/**
 * @module        StageEngine.skills.test
 * @description   v0.50.17：resolveRequiredSkills 纯函数回归测试——锁住 v0.50.9 的
 *                bug 修复（读 card.skills 而不是 labels），避免未来误回退。
 */
import { describe, expect, it } from 'vitest';
import { formatSkillRequirement, resolveRequiredSkills } from './StageEngine.js';

describe('resolveRequiredSkills', () => {
  it('reads card.skills as primary source (v0.42+ frontmatter)', () => {
    const skills = resolveRequiredSkills(
      { skills: ['golang', 'frontend'] },
      {},
      undefined,
    );
    expect(skills).toEqual(['golang', 'frontend']);
  });

  it('ignores stage.profile when card.skills non-empty', () => {
    const skills = resolveRequiredSkills(
      { skills: ['python'] },
      { profile: 'backend,devops' },
      'default-skill',
    );
    expect(skills).toEqual(['python']);
  });

  it('falls back to stage.profile when card.skills empty', () => {
    const skills = resolveRequiredSkills(
      { skills: [] },
      { profile: 'backend, devops ' },
      undefined,
    );
    expect(skills).toEqual(['backend', 'devops']);
  });

  it('falls back to DEFAULT_WORKER_SKILLS when card.skills + stage.profile empty', () => {
    const skills = resolveRequiredSkills(
      {},
      {},
      'code-reviewer,testing',
    );
    expect(skills).toEqual(['code-reviewer', 'testing']);
  });

  it('returns empty array when all three sources empty', () => {
    const skills = resolveRequiredSkills({}, {}, undefined);
    expect(skills).toEqual([]);
  });

  it('filters out empty strings in card.skills', () => {
    const skills = resolveRequiredSkills(
      { skills: ['golang', '', 'frontend', ''] },
      {},
      undefined,
    );
    expect(skills).toEqual(['golang', 'frontend']);
  });

  it('handles card.skills undefined (old cards without the field)', () => {
    const skills = resolveRequiredSkills(
      {},
      { profile: 'fallback' },
      undefined,
    );
    expect(skills).toEqual(['fallback']);
  });

  // v0.50.9 回归：确保 skill:* label 不被当作 skill 来源
  it('does NOT read skill: labels (v0.42 hard-break)', () => {
    const skills = resolveRequiredSkills(
      // @ts-expect-error: intentionally pass labels to prove they're ignored
      { skills: undefined, labels: ['skill:golang', 'skill:frontend'] },
      {},
      undefined,
    );
    expect(skills).toEqual([]);
  });
});

describe('formatSkillRequirement', () => {
  it('produces # Required Skills section', () => {
    const out = formatSkillRequirement(['golang', 'frontend']);
    expect(out).toContain('# Required Skills');
    expect(out).toContain('golang, frontend');
    expect(out).toContain('Load the dev-worker skill');
  });
});
