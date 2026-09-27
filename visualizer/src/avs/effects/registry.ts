import { AvsEffectRegistry } from '../executor.ts';
import { registerAvsAddBorders } from './add-borders.ts';
import { registerAvsClassicEffects, type AvsClassicEffectOptions } from './classic.ts';
import { registerAvsColorMap } from './color-map.ts';
import { registerAvsConvolutionFilter } from './convolution.ts';
import { registerAvsBasicTransforms } from './basic-transforms.ts';
import { registerAvsBeatParticleEffects } from './beat-particle.ts';
import { registerAvsBump } from './bump.ts';
import { registerAvsCoreEffects } from './core.ts';
import { registerAvsDynamicMovement } from './dynamic-movement.ts';
import { registerAvsFinalLowCountBuiltins } from './final-low-count-builtins.ts';
import { registerAvsMovement } from './movement.ts';
import { registerAvsLowCountBuiltins } from './low-count-builtins.ts';
import { registerAvsMultiFilter } from './multifilter.ts';
import { registerAvsNamedApeEffects } from './named-apes.ts';
import { registerAvsScriptedTransforms } from './scripted-transforms.ts';
import { registerAvsSuperScope } from './superscope.ts';
import { registerAvsText } from './text.ts';
import { registerAvsTexerEffects, type AvsTexerEffectOptions } from './texer.ts';

/** All source-grounded AVS effects currently available in the compatibility lane. */
export function createAvsCompatibilityRegistry(
  classicOptions: AvsClassicEffectOptions = {},
  texerOptions: AvsTexerEffectOptions = {},
): AvsEffectRegistry {
  const registry = new AvsEffectRegistry();
  registerAvsAddBorders(registry);
  registerAvsCoreEffects(registry);
  registerAvsBasicTransforms(registry);
  registerAvsBeatParticleEffects(registry);
  registerAvsBump(registry);
  registerAvsClassicEffects(registry, classicOptions);
  registerAvsColorMap(registry);
  registerAvsConvolutionFilter(registry);
  registerAvsMovement(registry);
  registerAvsLowCountBuiltins(registry);
  registerAvsMultiFilter(registry);
  registerAvsDynamicMovement(registry);
  registerAvsFinalLowCountBuiltins(registry);
  registerAvsNamedApeEffects(registry);
  registerAvsScriptedTransforms(registry);
  registerAvsSuperScope(registry);
  registerAvsText(registry);
  registerAvsTexerEffects(registry, texerOptions);
  return registry;
}
