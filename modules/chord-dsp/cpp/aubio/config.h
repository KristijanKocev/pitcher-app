/*
 * Minimal config.h for aubio 0.4.9 — iOS/Accelerate onset detection only.
 * Generated for the chord-dsp Nitro module.
 */

#ifndef AUBIO_CONFIG_H
#define AUBIO_CONFIG_H

/* Standard library headers — always available on iOS */
#define HAVE_STDLIB_H 1
#define HAVE_STDIO_H 1
#define HAVE_MATH_H 1
#define HAVE_STRING_H 1
#define HAVE_ERRNO_H 1
#define HAVE_LIMITS_H 1
#define HAVE_STDARG_H 1

/* Use C99 variadic macros */
#define HAVE_C99_VARARGS_MACROS 1

/* Accelerate framework for FFT + BLAS on iOS/macOS */
#ifndef HAVE_ACCELERATE
#define HAVE_ACCELERATE 1
#endif

/* We do NOT use double precision — aubio defaults to float (smpl_t = float) */
/* #undef HAVE_AUBIO_DOUBLE */

/* We do NOT use FFTW, Intel IPP, or complex.h */
/* #undef HAVE_FFTW3 */
/* #undef HAVE_FFTW3F */
/* #undef HAVE_INTEL_IPP */
/* #undef HAVE_COMPLEX_H */
/* #undef HAVE_SNDFILE */
/* #undef HAVE_SAMPLERATE */

#endif /* AUBIO_CONFIG_H */
