import { palette } from './palette';

export interface Theme {
    palette?: Record<string, string>;
}

export const theme = {
    palette: palette,
};
