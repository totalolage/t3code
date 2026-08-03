import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./dist/index.js", import.meta.url), "utf8");

function renderStatus(status) {
  let registeredComponent;
  let stateIndex = 0;
  const initialStates = [status, "", "", ""];
  const React = {
    Fragment: "Fragment",
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
  };
  const window = {
    __HERMES_PLUGIN_SDK__: {
      React,
      hooks: {
        useCallback(callback) {
          return callback;
        },
        useEffect() {},
        useState() {
          const value = initialStates[stateIndex++];
          return [value, () => {}];
        },
      },
      components: Object.fromEntries(
        ["Badge", "Button", "Card", "CardContent", "CardHeader", "CardTitle"].map(
          (name) => [name, name],
        ),
      ),
      fetchJSON() {},
    },
    __HERMES_PLUGINS__: {
      register(_name, component) {
        registeredComponent = component;
      },
    },
  };
  vm.runInNewContext(source, { window });
  return registeredComponent();
}

function nodes(root) {
  const found = [];
  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      found.push(value);
      visit(value.children);
    }
  }
  visit(root);
  return found;
}

function text(root) {
  const fragments = [];
  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      visit(value.children);
    } else if (typeof value === "string" || typeof value === "number") {
      fragments.push(String(value));
    }
  }
  visit(root);
  return fragments.join(" ");
}

function buttons(root) {
  return nodes(root)
    .filter((node) => node.type === "Button")
    .map((node) => ({ label: text(node), disabled: Boolean(node.props.disabled) }));
}

function currentStatus(overrides = {}) {
  return {
    desired_state: "installed",
    desired_tag: "v0.0.31",
    installed_tag: "v0.0.31",
    coherent: true,
    update_available: false,
    reconciliation_status: "idle",
    reconciliation_error: null,
    service_installed: true,
    service_running: true,
    reachable: true,
    watchdog_running: true,
    watch_misses: 0,
    watch_interval_seconds: 900,
    url: "http://127.0.0.1:3773",
    ...overrides,
  };
}

test("durably uninstalled service offers Install despite a stale s6 slot", () => {
  const page = renderStatus(
    currentStatus({
      desired_state: "uninstalled",
      installed_tag: null,
      coherent: false,
      service_running: false,
      reachable: false,
      watchdog_running: false,
    }),
  );

  assert.match(text(page), /Stale supervisor/);
  assert.ok(buttons(page).some(({ label }) => label === "Install and start"));
  assert.ok(!buttons(page).some(({ label }) => /Update service|Check for update/.test(label)));
});

test("durably uninstalled service distinguishes a stale running process", () => {
  const page = renderStatus(
    currentStatus({
      desired_state: "uninstalled",
      installed_tag: null,
      coherent: false,
      reachable: false,
      watchdog_running: false,
    }),
  );

  assert.match(text(page), /Stale process/);
  assert.ok(buttons(page).some(({ label }) => label === "Install and start"));
});

test("pre-PR50 backend schema requires a dashboard restart", () => {
  const page = renderStatus({
    installed_version: "0.0.30",
    coherent: true,
    service_installed: true,
    service_running: true,
    reachable: true,
    watchdog_running: true,
    watch_misses: 0,
    watch_interval_seconds: 900,
    url: "http://127.0.0.1:3773",
  });
  const pageText = text(page);

  assert.match(
    pageText,
    /Restart Hermes Dashboard to activate the updated plugin backend/,
  );
  assert.doesNotMatch(pageText, /No release tag/);
  assert.deepEqual(
    buttons(page).find(({ label }) => label === "Restart required"),
    { label: "Restart required", disabled: true },
  );
});

test("installed current service is shown as up to date", () => {
  const page = renderStatus(currentStatus());

  assert.match(text(page), /Up to date/);
  assert.ok(buttons(page).some(({ label }) => label === "Check for update"));
  assert.ok(buttons(page).some(({ label }) => label === "Remove service"));
});

test("installed older release is shown as update available", () => {
  const page = renderStatus(
    currentStatus({
      desired_tag: "v0.0.31",
      installed_tag: "v0.0.30",
      coherent: false,
      update_available: true,
    }),
  );

  assert.match(text(page), /Update available/);
  assert.ok(buttons(page).some(({ label }) => label === "Update service"));
});

test("current backend tag-resolution failure is not a restart-required state", () => {
  const page = renderStatus(
    currentStatus({ desired_tag: null, coherent: false, update_available: false }),
  );
  const pageText = text(page);

  assert.match(pageText, /No release tag/);
  assert.match(pageText, /Release tag unavailable/);
  assert.doesNotMatch(
    pageText,
    /Restart Hermes Dashboard to activate the updated plugin backend/,
  );
});

test("reconciliation failure takes precedence over current release labels", () => {
  const page = renderStatus(
    currentStatus({
      reachable: false,
      reconciliation_status: "failed",
      reconciliation_error: "Retained runtime checksum mismatch; use Install and start.",
    }),
  );
  const pageText = text(page);

  assert.match(pageText, /Recovery failed/);
  assert.match(pageText, /Retained runtime checksum mismatch/);
  assert.doesNotMatch(pageText, /Up to date/);
  assert.doesNotMatch(pageText, /Starting/);
});
