// Support for listening to context state changes and intercepting state queries
// NOTE: this system does not handle buffer bindings
/** @typedef {import('./track-context-state')} types */

import {GL_PARAMETER_DEFAULTS, GL_HOOKED_SETTERS, NON_CACHE_PARAMETERS} from './webgl-parameter-tables';
import {setParameters, getParameters} from './unified-parameter-api';
import {assert} from '../utils/assert';
import {deepArrayEqual} from '../utils/utils';

// HELPER FUNCTIONS - INSTALL GET/SET INTERCEPTORS (SPYS) ON THE CONTEXT

// Overrides a WebGLRenderingContext state "getter" function
// to return values directly from cache
function installGetterOverride(gl, functionName) {
  // Get the original function from the WebGLRenderingContext
  const originalGetterFunc = gl[functionName].bind(gl);

  // Wrap it with a spy so that we can update our state cache when it gets called
  gl[functionName] = function get(pname) {
    if (pname === undefined || NON_CACHE_PARAMETERS.has(pname)) {
      // Invalid or blacklisted parameter, do not cache
      return originalGetterFunc(pname);
    }

    if (!(pname in gl.state.cache)) {
      // WebGL limits are not prepopulated in the cache, call the original getter when first queried.
      gl.state.cache[pname] = originalGetterFunc(pname);
    }

    // Optionally call the original function to do a "hard" query from the WebGLRenderingContext
    return gl.state.enable
      ? // Call the getter the params so that it can e.g. serve from a cache
        gl.state.cache[pname]
      : // Optionally call the original function to do a "hard" query from the WebGLRenderingContext
        originalGetterFunc(pname);
  };

  // Set the name of this anonymous function to help in debugging and profiling
  Object.defineProperty(gl[functionName], 'name', {
    value: `${functionName}-from-cache`,
    configurable: false
  });
}

// Overrides a WebGLRenderingContext state "setter" function
// to call a setter spy before the actual setter. Allows us to keep a cache
// updated with a copy of the WebGL context state.
function installSetterSpy(gl, functionName, setter) {
  // Get the original function from the WebGLRenderingContext
  if (!gl[functionName]) {
    // This could happen if we try to intercept WebGL2 method on a WebGL1 context
    return;
  }
  const originalSetterFunc = gl[functionName].bind(gl);

  // Wrap it with a spy so that we can update our state cache when it gets called
  gl[functionName] = function set(...params) {
    // Update the value
    // Call the setter with the state cache and the params so that it can store the parameters
    const {valueChanged, oldValue} = setter(gl.state._updateCache, ...params);

    // Call the original WebGLRenderingContext func to make sure the context actually gets updated
    if (valueChanged) {
      originalSetterFunc(...params);
    }

    // Note: if the original function fails to set the value, our state cache will be bad
    // No solution for this at the moment, but assuming that this is unlikely to be a real problem
    // We could call the setter after the originalSetterFunc. Concern is that this would
    // cause different behavior in debug mode, where originalSetterFunc can throw exceptions

    return oldValue;
  };

  // Set the name of this anonymous function to help in debugging and profiling
  Object.defineProperty(gl[functionName], 'name', {
    value: `${functionName}-to-cache`,
    configurable: false
  });
}

function installProgramSpy(gl) {
  const originalUseProgram = gl.useProgram.bind(gl);

  gl.useProgram = function useProgramLuma(handle) {
    if (gl.state.program !== handle) {
      originalUseProgram(handle);
      gl.state.program = handle;
    }
  };
}

// HELPER CLASS - GLState

/* eslint-disable no-shadow */
class GLState {
  gl: WebGLRenderingContext;
  program = null;
  stateStack = [];
  enable = true;
  cache;
  log;

  constructor(
    gl,
    {
      copyState = false, // Copy cache from params (slow) or initialize from WebGL defaults (fast)
      log = () => {} // Logging function, called when gl parameter change calls are actually issued
    } = {}
  ) {
    this.gl = gl;
    this.cache = copyState ? getParameters(gl) : Object.assign({}, GL_PARAMETER_DEFAULTS);
    this.log = log;

    this._updateCache = this._updateCache.bind(this);
    Object.seal(this);
  }

  push(values = {}) {
    this.stateStack.push({});
  }

  pop() {
    assert(this.stateStack.length > 0);
    // Use the saved values in the state stack to restore parameters
    const oldValues = this.stateStack[this.stateStack.length - 1];
    setParameters(this.gl, oldValues);
    // Don't pop until we have reset parameters (to make sure other "stack frames" are not affected)
    this.stateStack.pop();
  }

  // interceptor for context set functions - update our cache and our stack
  // values (Object) - the key values for this setter
  _updateCache(values) {
    let valueChanged = false;
    let oldValue; // = undefined

    const oldValues = this.stateStack.length > 0 && this.stateStack[this.stateStack.length - 1];

    for (const key in values) {
      assert(key !== undefined);
      const value = values[key];
      const cached = this.cache[key];
      // Check that value hasn't already been shadowed
      if (!deepArrayEqual(value, cached)) {
        valueChanged = true;
        oldValue = cached;

        // First, save current value being shadowed
        // If a state stack frame is active, save the current parameter values for pop
        // but first check that value hasn't already been shadowed and saved
        if (oldValues && !(key in oldValues)) {
          oldValues[key] = cached;
        }

        // Save current value being shadowed
        this.cache[key] = value;
      }
    }

    return {valueChanged, oldValue};
  }
}

// PUBLIC API

/**
 * Initialize WebGL state caching on a context
 * can be called multiple times to enable/disable
 * 
 * @note After calling this function, context state will be cached
 * gl.state.push() and gl.state.pop() will be available for saving,
 * temporarily modifying, and then restoring state.
 */
 export function trackContextState(
  gl: WebGLRenderingContext,
  options?: {
    enable?: boolean;
    copyState?: boolean;
    log?: any;
  }
): WebGLRenderingContext {
  const {enable = true, copyState} = options;
  assert(copyState !== undefined);
  // @ts-expect-error
  if (!gl.state) {
    const global_ = typeof global !== 'undefined' ? global : window;
    // @ts-expect-error
    const {polyfillContext} = global_;
    if (polyfillContext) {
      polyfillContext(gl);
    }

    // Create a state cache
    // @ts-expect-error
    gl.state = new GLState(gl, {copyState});

    installProgramSpy(gl);

    // intercept all setter functions in the table
    for (const key in GL_HOOKED_SETTERS) {
      const setter = GL_HOOKED_SETTERS[key];
      installSetterSpy(gl, key, setter);
    }

    // intercept all getter functions in the table
    installGetterOverride(gl, 'getParameter');
    installGetterOverride(gl, 'isEnabled');
  }

  // @ts-expect-error
  gl.state.enable = enable;

  return gl;
}

/**
 * Saves current WebGL context state onto an internal per-context stack
 */
 export function pushContextState(gl: WebGLRenderingContext): void {
  // @ts-expect-error
  if (!gl.state) {
    trackContextState(gl, {copyState: false});
  }
  // @ts-expect-error
  gl.state.push();
}


/**
 * Restores previously saved WebGL context state
 */
export function popContextState(gl: WebGLRenderingContext): void {
  // @ts-expect-error
  assert(gl.state);
  // @ts-expect-error
  gl.state.pop();
}
