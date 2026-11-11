/**
 * Offline stand-in for the DSH-supplied `@deepseek-ai/schemastery` package.
 *
 * `lib/host/config.js` imports Schemastery from the running DSH installation,
 * which the offline test project cannot resolve. `test/host/host-entry.test.js`
 * maps that bare specifier here with `node:module` `registerHooks`, so the real
 * `lib/index.js` entry (and its `Config`) can be imported without a DSH install.
 *
 * This fixture implements only the chain the Config declaration uses:
 * `z.boolean().default(value).volatile()`. It is a host-entry contract smoke,
 * not a Schemastery schema validator; real schema validation still needs a
 * running installation.
 */

function createBooleanField() {
  let value;
  let defaultValue;
  let volatile = false;
  const field = {
    default(next) {
      defaultValue = next;
      value = next;
      return field;
    },
    volatile() {
      volatile = true;
      return field;
    },
    /** The live field value, as a Schemastery `@volatile` field exposes it. */
    get() {
      return value;
    },
    /** Test-only hook for flipping a switch after `apply()` (not part of Schemastery). */
    setValue(next) {
      value = next;
      return field;
    },
    get defaultValue() {
      return defaultValue;
    },
    get isVolatile() {
      return volatile;
    },
  };
  return field;
}

const z = {
  boolean: () => createBooleanField(),
  object: (shape) => shape,
};

export default z;
