const FLASH_MS = 5000;
const flashes = new WeakMap<HTMLButtonElement, number>();

function labelControl(element: HTMLButtonElement) {
  if (element.getAttribute("aria-label")?.trim()) {
    return;
  }
  const title = element.getAttribute("title")?.trim();
  const text = element.textContent?.replace(/\s+/g, " ").trim();
  element.setAttribute("aria-label", title || text || "Button");
}

export function labelControls(root: ParentNode = document) {
  root.querySelectorAll("button").forEach((button) => labelControl(button));
}

export function watchControlLabels() {
  labelControls();
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLButtonElement) {
          labelControl(node);
        } else if (node instanceof HTMLElement) {
          labelControls(node);
        }
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
}

export function isUnavailable(element: Element | null | undefined) {
  return element instanceof HTMLElement && element.classList.contains("is-unavailable");
}

function flashNotAvailable(button: HTMLButtonElement) {
  const pending = flashes.get(button);
  if (pending) {
    window.clearTimeout(pending);
  }
  if (!button.dataset.restingText) {
    button.dataset.restingText = button.textContent ?? "";
  }
  button.textContent = "Not Available";
  button.classList.add("is-not-available-text");
  flashes.set(
    button,
    window.setTimeout(() => {
      button.textContent = button.dataset.restingText ?? "";
      delete button.dataset.restingText;
      button.classList.remove("is-not-available-text");
      flashes.delete(button);
    }, FLASH_MS)
  );
}

export function showUnavailable(button: HTMLButtonElement | null | undefined) {
  if (button) {
    flashNotAvailable(button);
  }
}

/** Marks a control unavailable without the disabled attribute. */
export function setUnavailable(element: Element | null | undefined, unavailable: boolean) {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  if (element instanceof HTMLButtonElement) {
    labelControl(element);
  }
  element.removeAttribute("disabled");
  element.removeAttribute("aria-disabled");

  const becomingUnavailable = unavailable && !element.classList.contains("is-unavailable");
  if (!unavailable) {
    element.classList.remove("is-unavailable", "border", "border-2", "border-danger");
    if (element instanceof HTMLInputElement) {
      element.readOnly = false;
    }
    const saved = element.dataset.availableLabel;
    if (saved) {
      element.setAttribute("aria-label", saved);
      delete element.dataset.availableLabel;
    }
    return;
  }

  if (!element.dataset.availableLabel) {
    element.dataset.availableLabel = element.getAttribute("aria-label")?.trim()
      || element.getAttribute("title")?.trim()
      || (element instanceof HTMLButtonElement ? element.textContent?.replace(/\s+/g, " ").trim() : "")
      || "Control";
  }
  element.setAttribute("aria-label", "Not available, please wait");
  element.classList.add("is-unavailable", "border", "border-2", "border-danger");
  if (element instanceof HTMLInputElement) {
    element.readOnly = true;
  }
  if (becomingUnavailable && element instanceof HTMLButtonElement) {
    flashNotAvailable(element);
  }
}

export function blockUnavailableControls() {
  const controlFrom = (event: Event) =>
    (event.target as Element | null)?.closest("button, select, input");

  document.addEventListener("mousedown", (event) => {
    const control = controlFrom(event);
    if (!(control instanceof HTMLElement) || control instanceof HTMLButtonElement || !isUnavailable(control)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, true);

  document.addEventListener("click", (event) => {
    const control = controlFrom(event);
    if (!(control instanceof HTMLButtonElement) || !isUnavailable(control)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    flashNotAvailable(control);
  }, true);

  document.addEventListener("keydown", (event) => {
    const control = controlFrom(event);
    if (!(control instanceof HTMLElement) || !isUnavailable(control) || event.key === "Tab" || event.key === "Escape") {
      return;
    }
    if (control instanceof HTMLButtonElement && event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (control instanceof HTMLButtonElement) {
      flashNotAvailable(control);
    }
  }, true);
}
