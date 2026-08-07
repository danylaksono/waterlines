/**
 * createEngine.js
 *
 * Chooses between the two renderers.
 *
 * There are two, and both are kept, because they are good at different things
 * rather than one simply superseding the other:
 *
 *  - **`gl`** - the distance-field renderer (`gl/`). An order of magnitude
 *    faster, exact under pan and zoom instead of blitting a cached bitmap,
 *    free animation, and a waterline count that costs nothing. Needs WebGL2
 *    with float render targets.
 *  - **`2d`** - the stroke-and-erase renderer (`render/`), a direct port of
 *    Olivia Vane's notebook. Runs anywhere a canvas does, is what produces the
 *    print stills, and is the reference the GL path is checked against.
 *
 * The default is `auto`: GL where it works, 2D where it does not. The fallback
 * is real rather than decorative - `WaterlineGLEngine` throws
 * `GLUnavailableError` on a platform without float render targets, and that is
 * caught here.
 *
 * Importing the GL engine unconditionally is deliberate: nothing touches a GL
 * context until the constructor runs, so the cost of having it available is a
 * few kilobytes, and the alternative - a dynamic import - would make every
 * adapter constructor asynchronous for no benefit.
 */

import { WaterlineEngine } from './WaterlineEngine.js';
import { GLUnavailableError, WaterlineGLEngine } from '../gl/WaterlineGLEngine.js';

/**
 * @param {Object} [options] engine options, plus:
 * @param {'auto'|'gl'|'2d'} [options.renderer='auto']
 * @param {(err:Error) => void} [options.onFallback] called when `auto` wanted
 *   GL and could not have it
 * @returns {WaterlineEngine|WaterlineGLEngine} both present the same surface
 */
export function createEngine(options = {}) {
  const { renderer = 'auto', onFallback, ...rest } = options;
  if (renderer === '2d') return new WaterlineEngine(rest);

  try {
    return new WaterlineGLEngine(rest);
  } catch (err) {
    if (renderer === 'gl') throw err;
    // A GL failure must not take the overlay down with it. Anything thrown
    // while setting up a context - a missing extension, a lost context, a
    // driver refusing a float target - means 2D, which always works.
    if (onFallback) onFallback(err);
    else if (!(err instanceof GLUnavailableError)) console.warn('waterlines:', err);
    return new WaterlineEngine(rest);
  }
}
