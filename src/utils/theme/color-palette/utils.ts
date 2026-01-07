export const generateSolidColors = (
    hue: number,
    saturation: number
): Record<number, string> => {
    const solids: Record<number, string> = {};

    solids[1] = `hsl(${hue}, ${saturation}%, 99%)`;

    for (let i = 2; i <= 20; i++) {
        const lightness = 100 - (i - 1) * 5;
        solids[i] = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    }

    solids[21] = `hsl(${hue}, ${saturation}%, 1%)`;

    return solids;
};

export const generateTintColors = (
    hue: number,
    saturation: number,
    lightness: number
) => {
    const tints: Record<number, string> = {};

    tints[1] = `hsla(${hue}, ${saturation}%, ${lightness}%, 2.5%)`;

    for (let i = 2; i <= 20; i++) {
        const opacity = 100 - (i - 1) * 5;
        tints[i] = `hsl(${hue}, ${saturation}%, ${lightness}%, ${opacity}%)`;
    }
    tints[21] = `hsla(${hue}, ${saturation}%, ${lightness}%, 97.5%)`;

    return tints;
};
