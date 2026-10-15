// Adds a copy button to every code block. The page works without it.

// The agent prompt names this site's own address when the build had no SITE_URL.
for (const slot of document.querySelectorAll("[data-origin]")) slot.textContent = location.origin;

for (const figure of document.querySelectorAll("figure.code")) {
  const pre = figure.querySelector("pre");
  if (!pre || !navigator.clipboard) continue;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.textContent = "Copy";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.innerText.replace(/\n$/, ""));
      button.textContent = "Copied";
    } catch {
      button.textContent = "Press Ctrl+C";
    }
    setTimeout(() => (button.textContent = "Copy"), 1600);
  });
  figure.append(button);
}
