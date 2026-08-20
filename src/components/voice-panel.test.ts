import { describe, expect, it } from 'vitest';

import { toolLabel } from './voice-panel';

describe('toolLabel', () => {
  it('labels the shopping candidate add tool in Japanese', () => {
    expect(toolLabel('add_selected_shopping_candidates')).toBe('買い物リストに追加');
  });

  it('falls back to the raw tool name when unknown', () => {
    expect(toolLabel('some_unmapped_tool')).toBe('some_unmapped_tool');
  });
});
