/**
 * Arrow LOD stream 2D — GPU z-clip for the rising time-snake animation.
 *
 * Slices the combined tube mesh from the ground upward. The uniform is always
 * a finite number (`1e9` = effectively unclipped), unlike deck.gl's built-in
 * `ClipExtension` where `clipZ: false` disables the shader path entirely.
 *
 * WebGL only, same limitation as the built-in ClipExtension; the app runs
 * WebGL.
 */

import { LayerExtension } from '@deck.gl/core';

// luma declares the host-side uniform block as `<module.name>Uniforms`, and
// only modules that provide stage source get their declarations emitted, so
// the block is written out explicitly in both stages (same pattern as deck's
// built-in ClipExtension).
const zClipUniformBlock = `
layout(std140) uniform zClipUniforms {
  float clipZ;
} zClip;
`;

const zClipModule = {
    name: 'zClip',
    vs: zClipUniformBlock,
    fs: zClipUniformBlock,
    uniformTypes: {
        clipZ: 'f32',
    },
};

export default class ZClipExtension extends LayerExtension {
    getShaders() {
        return {
            // The module must be registered so the uniform block is declared
            // and uploaded by luma; the injections alone are not enough.
            modules: [zClipModule],
            inject: {
                'vs:#decl': `
out float vClipZ;
`,
                // One instance, no rotation/scale: mesh z is already metres.
                'vs:#main-end': `
vClipZ = positions.z;
`,
                'fs:#decl': `
in float vClipZ;
`,
                'fs:#main-start': `
if (vClipZ > zClip.clipZ) {
  discard;
}
`,
            },
        };
    }

    draw() {
        this.setShaderModuleProps({
            zClip: { clipZ: this.props.clipZ },
        });
    }
}

ZClipExtension.extensionName = 'ZClipExtension';
ZClipExtension.defaultProps = {
    clipZ: 1e9,
};
