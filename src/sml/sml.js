//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
//!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! J.J. !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
//^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
/* eslint-disable no-undef */
/* eslint-disable no-console */
"use strict";

import { jmlToHtml } from "./smlUtils.js";
import "./smlEngine.js";
import "./Form/smlForm.js";
import "./Table/smlTable.js";
import "./Table/smlTableExport.js";

export default class Sml {
  constructor() {
    this.attachStyles();
  }

  attachStyles() {
    const head = document.getElementsByTagName("head")[0];
    if (!document.getElementById("smly-css")) {
      const link = document.createElement("link");
      link.id = "smly-css";
      link.rel = "stylesheet";
      link.type = "text/css";
      link.href = `${location.origin}/js/global/sml/sml.css`;
      link.media = "all";
      head.appendChild(link);
    }

    if (!document.getElementById("smly-sidebar-css")) {
      const sidebarLink = document.createElement("link");
      sidebarLink.id = "smly-sidebar-css";
      sidebarLink.rel = "stylesheet";
      sidebarLink.type = "text/css";
      sidebarLink.href = `${location.origin}/js/global/sml/Page/smlSidebar.css`;
      sidebarLink.media = "all";
      head.appendChild(sidebarLink);
    }

    this.removeLegacyScripts();
  }

  removeLegacyScripts() {
    document.querySelectorAll("script[src*='jquery']").forEach(script => script.remove());
    document.querySelectorAll("script[src*='CATS.js']").forEach(script => script.remove());
  }

  renderPlaceholder(message) {
    return jmlToHtml({ n: "div", c: "sml-placeholder", t: message });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  globalThis.host = location.origin;
  globalThis._ = document;
  globalThis.smelly = new Sml();
  smelly.pageWrapper = document.querySelector("#pageContentWrapper");
  globalThis.jQuery = undefined;
  globalThis.$ = undefined;
  if (globalThis.jQuery && typeof globalThis.jQuery.fn === "object") {
    Object.keys(globalThis.jQuery.fn).forEach(fn => delete globalThis.jQuery.fn[fn]);
  }
});

//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
//!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! S.D.G !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
//^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^