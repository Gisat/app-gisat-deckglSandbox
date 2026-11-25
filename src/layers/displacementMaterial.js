/**
 * Lighting material shared by the 3D displacement symbols (spheres and arrows)
 * on the Arrow LOD stream maps.
 *
 * Matches the Arrow Gallery meshes so the streamed spheres and arrows shade
 * identically. Numeric `specularColor` is a deck.gl `Color` (RGB preset).
 */
export const DISPLACEMENT_SYMBOL_MATERIAL = {
    ambient: 0.45,
    diffuse: 0.75,
    shininess: 64,
    specularColor: [70, 70, 70]
};
