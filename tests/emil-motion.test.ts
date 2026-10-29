// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  animateSpring,
  installPressFeedback,
  springValue,
  type SpringScheduler,
} from "../apps/browser-extension/src/emil-motion";

afterEach(() => vi.unstubAllGlobals());

function clock() {
  let time = 0;
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const scheduler: SpringScheduler = {
    now: () => time,
    request: (callback) => {
      frames.set(++sequence, callback);
      return sequence;
    },
    cancel: (id) => {
      frames.delete(id);
    },
  };
  return {
    scheduler,
    pending: () => frames.size,
    advance(ms: number) {
      time += ms;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(time));
    },
  };
}

it("settles a resting critical spring monotonically without a frame-rate dependency", () => {
  const initial = { value: 0, velocity: 0 };
  let previous = initial;
  for (let frame = 0; frame < 100; frame++) {
    const next = springValue(previous, 100, 1 / 60);
    expect(next.value).toBeGreaterThanOrEqual(previous.value);
    expect(next.value).toBeLessThanOrEqual(100);
    previous = next;
  }
  expect(previous.value).toBeCloseTo(100, 7);
  const oneFrame = springValue(initial, 100, 0.08);
  const twoFrames = springValue(springValue(initial, 100, 0.03), 100, 0.05);
  expect(twoFrames.value).toBeCloseTo(oneFrame.value, 10);
  expect(twoFrames.velocity).toBeCloseTo(oneFrame.velocity, 10);
  expect(initial).toEqual({ value: 0, velocity: 0 });
});

it("retargets from the displayed position while carrying velocity through a reversal", () => {
  const time = clock();
  const onUpdate = vi.fn();
  const motion = animateSpring({
    from: 0,
    to: 100,
    scheduler: time.scheduler,
    reducedMotion: false,
    onUpdate,
  });
  time.advance(50);
  const displayed = motion.value;
  const carried = motion.velocity;
  expect(carried).toBeGreaterThan(0);
  motion.to(-40);
  expect(motion.value).toBe(displayed);
  expect(motion.velocity).toBe(carried);
  expect(time.pending()).toBe(1);
  time.advance(1);
  // A reversal bends the existing trajectory, it does not stop it instantly.
  expect(motion.value).toBeGreaterThan(displayed);
  expect(motion.velocity).toBeGreaterThan(0);
  time.advance(1500);
  expect(motion.value).toBe(-40);
  expect(motion.velocity).toBe(0);
  expect(motion.isRunning).toBe(false);
  expect(time.pending()).toBe(0);
});

it("cancels pending work without completing or moving, and can restart", () => {
  const time = clock();
  const onComplete = vi.fn();
  const onUpdate = vi.fn();
  const motion = animateSpring({
    from: 0,
    to: 100,
    scheduler: time.scheduler,
    reducedMotion: false,
    onUpdate,
    onComplete,
  });
  time.advance(40);
  const displayed = motion.value;
  motion.cancel();
  const updates = onUpdate.mock.calls.length;
  time.advance(2000);
  expect(time.pending()).toBe(0);
  expect(motion.value).toBe(displayed);
  expect(onUpdate).toHaveBeenCalledTimes(updates);
  expect(onComplete).not.toHaveBeenCalled();
  motion.to(200);
  time.advance(2000);
  expect(motion.value).toBe(200);
  expect(onComplete).toHaveBeenCalledExactlyOnceWith(200);
});

it("honors reduced motion before and during animation without leaving a frame behind", () => {
  const time = clock();
  let reduced = true;
  const motion = animateSpring({
    from: 0,
    to: 100,
    scheduler: time.scheduler,
    reducedMotion: () => reduced,
    onUpdate: vi.fn(),
  });
  expect(motion.value).toBe(100);
  expect(time.pending()).toBe(0);
  reduced = false;
  motion.to(0);
  time.advance(20);
  expect(motion.value).toBeGreaterThan(0);
  reduced = true;
  time.advance(16);
  expect(motion.value).toBe(0);
  expect(time.pending()).toBe(0);
});

it("gives feedback on pointerdown and removes listeners, capture and frames on cleanup", () => {
  const time = clock();
  vi.stubGlobal("requestAnimationFrame", time.scheduler.request);
  vi.stubGlobal("cancelAnimationFrame", time.scheduler.cancel);
  const root = document.createElement("div");
  root.innerHTML = '<button data-pressable style="opacity:0.8">Play</button>';
  document.body.appendChild(root);
  const button = root.querySelector("button")!;
  const releasePointerCapture = vi.fn();
  button.setPointerCapture = vi.fn();
  button.hasPointerCapture = () => true;
  button.releasePointerCapture = releasePointerCapture;
  const cleanup = installPressFeedback(root);
  const pointer = (type: string) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 7 });
    button.dispatchEvent(event);
  };
  pointer("pointerdown");
  expect(button.style.transform).toContain("scale(0.975)");
  expect(Number(button.style.opacity)).toBeLessThan(0.8);
  pointer("pointerup");
  expect(time.pending()).toBe(1);
  cleanup();
  expect(time.pending()).toBe(0);
  expect(releasePointerCapture).toHaveBeenCalledWith(7);
  expect(button.style.transform).toBe("");
  expect(button.style.opacity).toBe("0.8");
  pointer("pointerdown");
  expect(button.style.transform).toBe("");
  root.remove();
});
