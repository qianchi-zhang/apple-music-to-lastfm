// Guide navigation is presentation only; no step is marked as verified setup.
const stepIds = ["prepare", "connect", "help", "existing"];
const legacySteps = {
  deploy: "connect",
  apple: "connect",
  lastfm: "connect",
  start: "connect",
};
function showStep() {
  const requested = location.hash.slice(1);
  const current = stepIds.includes(requested)
    ? requested
    : Object.hasOwn(legacySteps, requested)
      ? legacySteps[requested]
      : "prepare";
  for (const id of stepIds) {
    document.getElementById(id).hidden = id !== current;
    const link = document.querySelector('nav a[href="#' + id + '"]');
    if (id === current) link.setAttribute("aria-current", "step");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", showStep);
showStep();
