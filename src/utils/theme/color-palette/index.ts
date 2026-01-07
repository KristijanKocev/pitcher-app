import { blueSolids, blueTintsLight, blueTintsDark } from './colors/blue';
import { greenSolids, greenTintsLight, greenTintsDark } from './colors/green';
import {
    monochromeSolids,
    monochromeTintsLight,
    monochromeTintsDark,
} from './colors/monochrome';
import {
    orangeSolids,
    orangeTintsLight,
    orangeTintsDark,
} from './colors/orange';
import {
    primarySolids,
    primaryTintsLight,
    primaryTintsDark,
} from './colors/primary';
import {
    purpleSolids,
    purpleTintsLight,
    purpleTintsDark,
} from './colors/purple';
import { redSolids, redTintsDark, redTintsLight } from './colors/red';
import {
    yellowSolids,
    yellowTintsLight,
    yellowTintsDark,
} from './colors/yellow';

const paletteBase = {
    red: {
        solid: redSolids,
        tint: {
            light: redTintsLight,
            dark: redTintsDark,
        },
    },
    blue: {
        solid: blueSolids,
        tint: {
            light: blueTintsLight,
            dark: blueTintsDark,
        },
    },
    green: {
        solid: greenSolids,
        tint: {
            light: greenTintsLight,
            dark: greenTintsDark,
        },
    },
    yellow: {
        solid: yellowSolids,
        tint: {
            light: yellowTintsLight,
            dark: yellowTintsDark,
        },
    },
    purple: {
        solid: purpleSolids,
        tint: {
            light: purpleTintsLight,
            dark: purpleTintsDark,
        },
    },
    orange: {
        solid: orangeSolids,
        tint: {
            light: orangeTintsLight,
            dark: orangeTintsDark,
        },
    },
    primary: {
        solid: primarySolids,
        tint: {
            light: primaryTintsLight,
            dark: primaryTintsDark,
        },
    },
    monochrome: {
        solid: monochromeSolids,
        tint: {
            light: monochromeTintsLight,
            dark: monochromeTintsDark,
        },
    },
};

export const paletteTokens = {
    primary: {
        main: paletteBase.primary.solid[1],
        onMain: paletteBase.monochrome.solid[17],
        mainContainer: paletteBase.primary.solid[19],
        onMainContainer: paletteBase.primary.solid[2],
        mainBorder: paletteBase.primary.solid[17],
        onSurface: paletteBase.primary.solid[2],
        onSurfaceVariant: paletteBase.primary.solid[4],
        surface: {
            1: paletteBase.primary.solid[20],
            2: paletteBase.primary.solid[18],
            3: paletteBase.primary.solid[17],
            4: paletteBase.primary.solid[16],
            5: paletteBase.primary.solid[15],
        },
        tint: {
            regular: paletteBase.primary.tint.dark[2],
            dense: paletteBase.primary.tint.dark[3],
            onMainRegular: paletteBase.primary.tint.light[3],
            onMainDense: paletteBase.primary.tint.light[5],
        },
    },
    monochrome: {
        main: paletteBase.monochrome.solid[1],
        onMain: paletteBase.monochrome.solid[17],
        mainContainer: paletteBase.monochrome.solid[19],
        onMainContainer: paletteBase.monochrome.solid[2],
        mainBorder: paletteBase.monochrome.solid[17],
        onSurface: paletteBase.monochrome.solid[2],
        onSurfaceVariant: paletteBase.monochrome.solid[4],
        surface: {
            1: paletteBase.monochrome.solid[19],
            2: paletteBase.monochrome.solid[18],
            3: paletteBase.monochrome.solid[17],
            4: paletteBase.monochrome.solid[16],
            5: paletteBase.monochrome.solid[15],
        },
        tint: {
            regular: paletteBase.monochrome.tint.dark[2],
            dense: paletteBase.monochrome.tint.dark[3],
            onMainRegular: paletteBase.monochrome.tint.light[3],
            onMainDense: paletteBase.monochrome.tint.light[5],
        },
    },
    red: {
        main: paletteBase.red.solid[4],
        onMain: paletteBase.red.solid[20],
        mainContainer: paletteBase.red.solid[17],
        onMainContainer: paletteBase.red.solid[2],
        onSurface: paletteBase.red.solid[2],
        onSurfaceVariant: paletteBase.red.solid[4],
        border: paletteBase.red.solid[18],
        surface: {
            1: paletteBase.red.solid[19],
            2: paletteBase.red.solid[18],
            3: paletteBase.red.solid[17],
            4: paletteBase.red.solid[16],
            5: paletteBase.red.solid[15],
        },
        tint: {
            regular: paletteBase.red.tint.dark[2],
            dense: paletteBase.red.tint.dark[3],
            onMainRegular: paletteBase.red.tint.light[3],
            onMainDense: paletteBase.red.tint.light[5],
        },
    },
    green: {
        main: paletteBase.green.solid[4],
        onMain: paletteBase.green.solid[19],
        mainContainer: paletteBase.green.solid[17],
        onMainContainer: paletteBase.green.solid[2],
        onSurface: paletteBase.green.solid[2],
        onSurfaceVariant: paletteBase.green.solid[4],
        border: paletteBase.green.solid[15],
        surface: {
            1: paletteBase.green.solid[19],
            2: paletteBase.green.solid[18],
            3: paletteBase.green.solid[17],
            4: paletteBase.green.solid[16],
            5: paletteBase.green.solid[15],
        },
        tint: {
            regular: paletteBase.green.tint.dark[2],
            dense: paletteBase.green.tint.dark[3],
            onMainRegular: paletteBase.green.tint.light[3],
            onMainDense: paletteBase.green.tint.light[5],
        },
    },
    yellow: {
        main: paletteBase.yellow.solid[4],
        onMain: paletteBase.yellow.solid[17],
        mainContainer: paletteBase.yellow.solid[20],
        onMainContainer: paletteBase.yellow.solid[3],
        onSurface: paletteBase.yellow.solid[2],
        onSurfaceVariant: paletteBase.yellow.solid[4],
        border: paletteBase.yellow.solid[17],
        surface: {
            1: paletteBase.yellow.solid[19],
            2: paletteBase.yellow.solid[18],
            3: paletteBase.yellow.solid[17],
            4: paletteBase.yellow.solid[16],
            5: paletteBase.yellow.solid[15],
        },
        tint: {
            regular: paletteBase.yellow.tint.dark[2],
            dense: paletteBase.yellow.tint.dark[3],
            onMainRegular: paletteBase.yellow.tint.light[3],
            onMainDense: paletteBase.yellow.tint.light[5],
        },
    },
    orange: {
        main: paletteBase.orange.solid[5],
        onMain: paletteBase.orange.solid[20],
        mainContainer: paletteBase.orange.solid[20],
        onMainContainer: paletteBase.orange.solid[5],
        onSurface: paletteBase.orange.solid[2],
        onSurfaceVariant: paletteBase.orange.solid[4],
        border: paletteBase.orange.solid[17],
        surface: {
            1: paletteBase.orange.solid[19],
            2: paletteBase.orange.solid[18],
            3: paletteBase.orange.solid[17],
            4: paletteBase.orange.solid[16],
            5: paletteBase.orange.solid[15],
        },
        tint: {
            regular: paletteBase.orange.tint.dark[2],
            dense: paletteBase.orange.tint.dark[3],
            onMainRegular: paletteBase.orange.tint.light[3],
            onMainDense: paletteBase.orange.tint.light[5],
        },
    },
    purple: {
        main: paletteBase.purple.solid[5],
        onMain: paletteBase.purple.solid[21],
        mainContainer: paletteBase.purple.solid[16],
        onMainContainer: paletteBase.purple.solid[3],
        onSurface: paletteBase.purple.solid[2],
        onSurfaceVariant: paletteBase.purple.solid[6],
        border: paletteBase.purple.solid[18],
        surface: {
            1: paletteBase.purple.solid[19],
            2: paletteBase.purple.solid[18],
            3: paletteBase.purple.solid[17],
            4: paletteBase.purple.solid[16],
            5: paletteBase.purple.solid[15],
        },
        tint: {
            regular: paletteBase.purple.tint.dark[2],
            dense: paletteBase.purple.tint.dark[3],
            onMainRegular: paletteBase.purple.tint.light[3],
            onMainDense: paletteBase.purple.tint.light[5],
        },
    },
    blue: {
        main: paletteBase.blue.solid[17],
        onMain: paletteBase.blue.solid[21],
        mainContainer: paletteBase.blue.solid[16],
        onMainContainer: paletteBase.blue.solid[3],
        onSurface: paletteBase.blue.solid[2],
        onSurfaceVariant: paletteBase.blue.solid[6],
        border: paletteBase.blue.solid[18],
        surface: {
            1: paletteBase.blue.solid[19],
            2: paletteBase.blue.solid[18],
            3: paletteBase.blue.solid[17],
            4: paletteBase.blue.solid[16],
            5: paletteBase.blue.solid[15],
        },
        tint: {
            regular: paletteBase.blue.tint.dark[2],
            dense: paletteBase.blue.tint.dark[3],
            onMainRegular: paletteBase.blue.tint.light[3],
            onMainDense: paletteBase.blue.tint.light[5],
        },
    },
};
