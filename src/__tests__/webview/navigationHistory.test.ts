import { NavigationHistory } from '../../webview/utils/navigationHistory';

describe('NavigationHistory', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('records idle cursor positions and navigates back and forward', () => {
    const history = new NavigationHistory({ minDistance: 10, idleMs: 100 });

    history.recordPosition(1);
    jest.advanceTimersByTime(100);

    history.recordPosition(30);
    jest.advanceTimersByTime(100);

    history.recordPosition(70);
    jest.advanceTimersByTime(100);

    expect(history.navigateBack()).toBe(30);
    expect(history.navigateBack()).toBe(1);
    expect(history.navigateBack()).toBeNull();

    expect(history.navigateForward()).toBe(30);
    expect(history.navigateForward()).toBe(70);
    expect(history.navigateForward()).toBeNull();
  });

  it('ignores short cursor moves and clears forward history after a new position', () => {
    const history = new NavigationHistory({ minDistance: 10, idleMs: 100 });

    history.seed(1);
    history.recordPosition(5, { immediate: true });
    history.recordPosition(40, { immediate: true });

    expect(history.navigateBack()).toBe(1);

    history.recordPosition(80, { immediate: true });

    expect(history.navigateForward()).toBeNull();
    expect(history.navigateBack()).toBe(1);
  });

  it('suppresses recording while a programmatic jump is active', () => {
    const history = new NavigationHistory({ minDistance: 10, idleMs: 100 });

    history.seed(1);
    history.suppressDuring(() => {
      history.recordPosition(100, { immediate: true });
    });

    expect(history.currentPosition).toBe(1);
    expect(history.navigateBack()).toBeNull();
  });

  it('keeps only the configured number of back entries', () => {
    const history = new NavigationHistory({ maxEntries: 2, minDistance: 1, idleMs: 100 });

    history.seed(1);
    history.recordPosition(10, { immediate: true });
    history.recordPosition(20, { immediate: true });
    history.recordPosition(30, { immediate: true });

    expect(history.navigateBack()).toBe(20);
    expect(history.navigateBack()).toBe(10);
    expect(history.navigateBack()).toBeNull();
  });
});
