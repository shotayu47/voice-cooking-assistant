import { describe, expect, it } from 'vitest';

import { shouldRefreshAfterTurn } from './chat-view';

describe('shouldRefreshAfterTurn', () => {
  it('refreshes when shoppingChanged is true, even if inventoryChanged is false', () => {
    expect(
      shouldRefreshAfterTurn({ inventoryChanged: false, shoppingChanged: true }),
    ).toBe(true);
  });

  it('refreshes when inventoryChanged is true, even if shoppingChanged is false', () => {
    expect(
      shouldRefreshAfterTurn({ inventoryChanged: true, shoppingChanged: false }),
    ).toBe(true);
  });

  it('does not refresh when both are false', () => {
    expect(
      shouldRefreshAfterTurn({ inventoryChanged: false, shoppingChanged: false }),
    ).toBe(false);
  });
});
