/**
 * Small, independent motion primitives for the Emil Apple Design console.
 * The critical spring uses its analytic solution, so interrupted motion keeps
 * its velocity and a delayed frame cannot make the integrator unstable.
 */
export interface SpringState {
  value: number;
  /** Units per second, in the same units as `value`. */
  velocity: number;
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function positive(value: number, name: string): void {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be greater than zero`);
}

/**
 * Advance a critically damped spring without mutating the input state.
 * `elapsedSeconds` is time since the last displayed frame, not a duration.
 * `response` is the natural response in seconds; 0.3–0.4 suits UI movement.
 */
export function springValue(
  state: SpringState,
  target: number,
  elapsedSeconds: number,
  response = 0.34,
): SpringState {
  finite(state.value, "value");
  finite(state.velocity, "velocity");
  finite(target, "target");
  finite(elapsedSeconds, "elapsedSeconds");
  positive(response, "response");
  if (elapsedSeconds < 0)
    throw new RangeError("elapsedSeconds must not be negative");
  if (elapsedSeconds === 0) return { ...state };

  const frequency = (2 * Math.PI) / response;
  const displacement = state.value - target;
  const carriedVelocity = state.velocity + frequency * displacement;
  const decay = Math.exp(-frequency * elapsedSeconds);
  return {
    value: target + (displacement + carriedVelocity * elapsedSeconds) * decay,
    velocity:
      (state.velocity - frequency * carriedVelocity * elapsedSeconds) * decay,
  };
}

export interface SpringScheduler {
  now(): number;
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

export interface SpringOptions {
  from: number;
  to?: number;
  response?: number;
  restDelta?: number;
  restSpeed?: number;
  /** Write transform/opacity here; avoid layout reads or writes in a frame. */
  onUpdate(value: number): void;
  onComplete?(value: number): void;
  /** Defaults to the operating system preference; can be supplied for tests. */
  reducedMotion?: boolean | (() => boolean);
  scheduler?: SpringScheduler;
}

export interface SpringController {
  readonly value: number;
  readonly velocity: number;
  readonly target: number;
  readonly isRunning: boolean;
  /** Retargets from the last displayed value, retaining velocity by default. */
  to(
    target: number,
    options?: { velocity?: number; immediate?: boolean },
  ): void;
  /** Sets a new displayed value and clears movement, without onComplete. */
  jump(value: number): void;
  /** Cancels the frame and freezes at the current displayed value. */
  cancel(): void;
}

/**
 * Make one scalar spring and keep the controller for the element's lifetime.
 * Example: onUpdate: x => panel.style.transform = `translate3d(${x}px,0,0)`.
 * Call `.to(newX)` for every change, including an in-flight reversal; call
 * `.cancel()` before removing the element. No CSS transition is required.
 */
export function animateSpring(options: SpringOptions): SpringController {
  finite(options.from, "from");
  const response = options.response ?? 0.34;
  const restDelta = options.restDelta ?? 0.01;
  const restSpeed = options.restSpeed ?? 0.05;
  positive(response, "response");
  positive(restDelta, "restDelta");
  positive(restSpeed, "restSpeed");

  const scheduler = options.scheduler ?? {
    now: () => performance.now(),
    request: (callback: FrameRequestCallback) =>
      requestAnimationFrame(callback),
    cancel: (id: number) => cancelAnimationFrame(id),
  };
  const reduce = () => {
    if (typeof options.reducedMotion === "function")
      return options.reducedMotion();
    return (
      options.reducedMotion ??
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
      false
    );
  };
  let state: SpringState = { value: options.from, velocity: 0 };
  let target = options.from;
  let frame: number | null = null;
  let lastTime = 0;
  let running = false;

  function cancel() {
    if (frame !== null) scheduler.cancel(frame);
    frame = null;
    running = false;
    state.velocity = 0;
  }

  function finish() {
    cancel();
    state.value = target;
    const completedTarget = target;
    options.onUpdate(state.value);
    // An update callback may retarget or cancel its own controller.
    if (!running && target === completedTarget)
      options.onComplete?.(completedTarget);
  }

  function requestFrame() {
    if (frame === null && running) frame = scheduler.request(tick);
  }

  function tick(time: number) {
    frame = null;
    if (!running) return;
    if (reduce()) {
      finish();
      return;
    }
    state = springValue(
      state,
      target,
      Math.max(0, time - lastTime) / 1000,
      response,
    );
    lastTime = time;
    if (
      Math.abs(state.value - target) <= restDelta &&
      Math.abs(state.velocity) <= restSpeed
    ) {
      finish();
      return;
    }
    options.onUpdate(state.value);
    requestFrame();
  }

  const controller: SpringController = {
    get value() {
      return state.value;
    },
    get velocity() {
      return state.velocity;
    },
    get target() {
      return target;
    },
    get isRunning() {
      return running;
    },
    to(nextTarget, change = {}) {
      finite(nextTarget, "target");
      if (change.velocity !== undefined) finite(change.velocity, "velocity");
      target = nextTarget;
      if (change.velocity !== undefined) state.velocity = change.velocity;
      if (
        change.immediate ||
        reduce() ||
        (Math.abs(state.value - target) <= restDelta &&
          Math.abs(state.velocity) <= restSpeed)
      ) {
        finish();
        return;
      }
      if (!running) lastTime = scheduler.now();
      running = true;
      requestFrame();
    },
    jump(value) {
      finite(value, "value");
      cancel();
      state.value = target = value;
      options.onUpdate(value);
    },
    cancel,
  };
  options.onUpdate(state.value);
  if (options.to !== undefined) controller.to(options.to);
  return controller;
}

/**
 * Install immediate pointer-down and keyboard feedback for `[data-pressable]`
 * controls inside `root`. Existing inline styles are restored after release.
 * Use an inner wrapper if another animation owns the control's transform.
 * Native click behavior is untouched. The returned function releases every
 * listener, pointer capture and pending animation before a rerender/unmount.
 */
export function installPressFeedback(
  root: HTMLElement,
  selector = "[data-pressable]",
): () => void {
  const view = root.ownerDocument.defaultView;
  if (!view) return () => {};
  const ElementConstructor = view.Element;
  const HTMLElementConstructor = view.HTMLElement;
  let active: {
    element: HTMLElement;
    pointerId: number | null;
    holding: boolean;
    transform: string;
    opacity: string;
    spring: SpringController;
  } | null = null;
  const media = view.matchMedia?.("(prefers-reduced-motion: reduce)");

  function find(target: EventTarget | null) {
    const element =
      target instanceof ElementConstructor ? target.closest(selector) : null;
    return element instanceof HTMLElementConstructor &&
      root.contains(element) &&
      !element.matches(":disabled, [aria-disabled='true']")
      ? element
      : null;
  }

  function clear() {
    if (!active) return;
    const previous = active;
    active = null;
    previous.spring.cancel();
    previous.element.style.transform = previous.transform;
    previous.element.style.opacity = previous.opacity;
    if (
      previous.pointerId !== null &&
      previous.element.hasPointerCapture?.(previous.pointerId)
    )
      previous.element.releasePointerCapture(previous.pointerId);
  }

  function press(element: HTMLElement, pointerId: number | null) {
    clear();
    const transform = element.style.transform;
    const opacity = element.style.opacity;
    const computed = view!.getComputedStyle(element);
    const baseTransform =
      computed.transform === "none" ? "" : computed.transform;
    const baseOpacity = Number(computed.opacity) || 1;
    const spring = animateSpring({
      from: 0,
      response: 0.28,
      reducedMotion: () => media?.matches ?? false,
      onUpdate: (amount) => {
        element.style.transform = media?.matches
          ? transform
          : `${baseTransform} scale(${1 - 0.025 * amount})`.trim();
        element.style.opacity = String(baseOpacity * (1 - 0.16 * amount));
      },
      onComplete: () => {
        if (active?.element === element) clear();
      },
    });
    active = { element, pointerId, holding: true, transform, opacity, spring };
    // The first visual change happens during pointerdown, before pointerup.
    spring.jump(1);
    if (pointerId !== null) element.setPointerCapture?.(pointerId);
  }

  function release(event?: Event) {
    if (!active) return;
    if (
      event &&
      "pointerId" in event &&
      active.pointerId !== (event as PointerEvent).pointerId
    )
      return;
    active.holding = false;
    active.spring.to(0);
  }

  function down(event: PointerEvent) {
    if (event.button !== 0 || event.isPrimary === false) return;
    const element = find(event.target);
    if (element) press(element, event.pointerId);
  }

  function move(event: PointerEvent) {
    if (!active?.holding || active.pointerId !== event.pointerId) return;
    const bounds = active.element.getBoundingClientRect();
    const inside =
      event.clientX >= bounds.left - 10 &&
      event.clientX <= bounds.right + 10 &&
      event.clientY >= bounds.top - 10 &&
      event.clientY <= bounds.bottom + 10;
    active.spring.jump(inside ? 1 : 0);
  }

  function keyDown(event: KeyboardEvent) {
    if (event.repeat || (event.key !== " " && event.key !== "Enter")) return;
    const element = find(event.target);
    if (element) press(element, null);
  }

  function keyUp(event: KeyboardEvent) {
    if (event.key === " " || event.key === "Enter") release();
  }

  root.addEventListener("pointerdown", down);
  root.addEventListener("pointermove", move);
  root.addEventListener("keydown", keyDown);
  root.addEventListener("keyup", keyUp);
  root.addEventListener("focusout", clear);
  root.addEventListener("lostpointercapture", release);
  view.addEventListener("pointerup", release);
  view.addEventListener("pointercancel", clear);
  view.addEventListener("blur", clear);

  return () => {
    clear();
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("keydown", keyDown);
    root.removeEventListener("keyup", keyUp);
    root.removeEventListener("focusout", clear);
    root.removeEventListener("lostpointercapture", release);
    view.removeEventListener("pointerup", release);
    view.removeEventListener("pointercancel", clear);
    view.removeEventListener("blur", clear);
  };
}
