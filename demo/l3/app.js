const checkout = document.getElementById("checkout");
const confirm = document.getElementById("order-confirm");
const cookies = document.getElementById("accept-cookies");
const video = document.getElementById("hero-video");

if (checkout && confirm) {
  checkout.addEventListener("click", () => {
    document.body.classList.add("ordered");
    confirm.hidden = false;
  });
}

if (cookies) {
  cookies.addEventListener("click", () => {
    const banner = cookies.closest("[data-lift-cookie]");
    if (banner) banner.remove();
  });
}

if (video) {
  video.addEventListener("error", () => {
    video.removeAttribute("src");
    video.load();
    video.hidden = true;
  });
  const play = video.play();
  if (play && typeof play.catch === "function") {
    play.catch(() => {
      /* autoplay can be blocked; the CSS hero still moves */
    });
  }
}

document.addEventListener("lift:sensory-safe", (event) => {
  const on = Boolean(event.detail?.on);
  document.querySelectorAll("[data-lift-carousel]").forEach((node) => {
    node.dataset.liftPaused = on ? "1" : "0";
  });
});
