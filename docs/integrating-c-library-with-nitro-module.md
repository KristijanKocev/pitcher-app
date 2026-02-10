# Integrating a Vendored C Library with a React Native Nitro Module (iOS)

A detailed guide based on integrating [aubio](https://aubio.org/) (a C audio analysis library) into a NitroModules-based React Native module. This documents every pitfall encountered and the reasoning behind each solution.

---

## Table of Contents

1. [Overview](#overview)
2. [Directory Structure](#directory-structure)
3. [The Podspec — The Most Critical File](#the-podspec--the-most-critical-file)
4. [Including C Headers in C++ Code](#including-c-headers-in-c-code)
5. [Why You Cannot Use an `extern "C"` Bridge File](#why-you-cannot-use-an-extern-c-bridge-file)
6. [C Code That Breaks Under C++ Compilation](#c-code-that-breaks-under-c-compilation)
7. [Forward Declarations vs. Real Includes](#forward-declarations-vs-real-includes)
8. [The Expo Config Plugin](#the-expo-config-plugin)
9. [What NOT to Do](#what-not-to-do)
10. [Quick Checklist](#quick-checklist)

---

## Overview

NitroModules uses C++20 with Swift/C++ interop to bridge native code to JavaScript. The build chain is:

```
TypeScript spec (.nitro.ts)
    ↓  nitrogen codegen
C++ abstract class (HybridChordDSPSpec.hpp)
    ↓  you implement
C++ implementation (HybridChordDSP.hpp/.cpp)  ←  calls C library here
    ↓  nitrogen bridge
ObjC++ autolinking (.mm) + Swift autolinking (.swift)
    ↓  CocoaPods
Xcode build
```

The challenge: your C++ implementation needs to call a plain C library, and CocoaPods + NitroModules + Swift interop all have opinions about how headers and modules are organized.

---

## Directory Structure

Place the vendored C library under your module's `cpp/` directory:

```
modules/chord-dsp/
├── cpp/
│   ├── HybridChordDSP.hpp          # Your C++ header
│   ├── HybridChordDSP.cpp          # Your C++ implementation
│   └── aubio/                       # Vendored C library
│       ├── aubio.h                  # Main umbrella header
│       ├── aubio_priv.h             # Private/internal header
│       ├── config.h                 # Build configuration
│       ├── types.h                  # Type definitions
│       ├── fvec.h / fvec.c          # Core types
│       ├── spectral/                # Subdirectory modules
│       │   ├── fft.h / fft.c
│       │   └── ...
│       ├── onset/
│       │   ├── onset.h / onset.c
│       │   └── ...
│       └── ...
├── ios/
│   └── Bridge.h
├── nitrogen/
│   └── generated/                   # Auto-generated — do not edit
├── NitroChordDsp.podspec
├── src/
│   └── specs/
│       └── ChordDSP.nitro.ts       # Nitrogen spec
└── package.json
```

---

## The Podspec — The Most Critical File

This is where most integration issues originate. The order of operations matters enormously.

### The Golden Rule: Set `pod_target_xcconfig` BEFORE `add_nitrogen_files()`

The nitrogen autolinking script (`NitroChordDsp+autolinking.rb`) reads your current `pod_target_xcconfig`, **merges** its own settings into it, and writes the result back. If you set `pod_target_xcconfig` **after** calling `add_nitrogen_files()`, you **overwrite** the merged result and lose these critical nitrogen settings:

- `CLANG_CXX_LANGUAGE_STANDARD = c++20`
- `SWIFT_OBJC_INTEROP_MODE = objcxx`
- `DEFINES_MODULE = YES`

Without these, Swift/C++ interop is completely broken and you get errors like:
```
cannot find type 'margelo' in scope
```

### Working Podspec

```ruby
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "NitroChordDsp"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported, :visionos => 1.0 }
  s.source       = { :git => "...", :tag => "#{s.version}" }

  s.source_files = [
    "ios/**/*.{swift}",
    "ios/**/*.{m,mm}",
    "cpp/**/*.{hpp,cpp}",
    # Vendored C library — compiled as plain C source files
    "cpp/aubio/**/*.{h,c}",
  ]

  s.frameworks = "Accelerate"

  # !! MUST come BEFORE add_nitrogen_files !!
  s.pod_target_xcconfig = {
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) HAVE_CONFIG_H=1 HAVE_ACCELERATE=1',
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/cpp/aubio"',
  }

  # Nitrogen autolinking MERGES its settings into the above.
  # If pod_target_xcconfig were set after this call, nitrogen's
  # C++20, Swift interop, and DEFINES_MODULE settings would be lost.
  load 'nitrogen/generated/ios/NitroChordDsp+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
```

### Key Points

| Setting | Purpose |
|---|---|
| `"cpp/aubio/**/*.{h,c}"` in `source_files` | Compiles C files as plain C (not C++) |
| `HEADER_SEARCH_PATHS` with aubio dir | Lets aubio files find each other via `#include "aubio_priv.h"` |
| `$(inherited)` prefix on all settings | Preserves search paths/definitions from CocoaPods and nitrogen |
| `s.frameworks = "Accelerate"` | Links Apple's Accelerate framework (used by aubio for FFT) |

---

## Including C Headers in C++ Code

### In Your `.hpp` Header

Use `extern "C" { }` to include the C headers you need for type declarations:

```cpp
#pragma once

#include "HybridChordDSPSpec.hpp"
#include <vector>

// Include actual aubio type definitions
extern "C" {
#include "aubio/types.h"
#include "aubio/fvec.h"
#include "aubio/onset/onset.h"
}

namespace margelo::nitro::chorddsp {

class HybridChordDSP : public HybridChordDSPSpec {
  // ...
private:
  aubio_onset_t* onsetDetector_ = nullptr;
  fvec_t* onsetInput_ = nullptr;
  fvec_t* onsetOutput_ = nullptr;
  uint_t onsetHopSize_ = 0;
};

} // namespace margelo::nitro::chorddsp
```

### In Your `.cpp` Implementation

If the C library's umbrella header already has `extern "C"` guards (check for `#ifdef __cplusplus` in the header), you can include it directly:

```cpp
#include "HybridChordDSP.hpp"

// aubio.h already contains:
//   #ifdef __cplusplus
//   extern "C" {
//   #endif
//   ...
//   #ifdef __cplusplus
//   }
//   #endif
#include "aubio/aubio.h"
```

If the library does NOT have its own guards, wrap the include:

```cpp
extern "C" {
#include "some_c_library.h"
}
```

### What `extern "C"` Actually Does

`extern "C"` tells the C++ compiler to use **C linkage** (no name mangling) for the enclosed declarations. This is necessary because:

1. The C library's `.c` files are compiled as C, producing symbols like `_new_aubio_onset`
2. Without `extern "C"`, the C++ compiler would look for a mangled name like `_Z15new_aubio_onsetPKcjjj`
3. The linker would fail with "undefined symbol" errors

**Important:** `extern "C"` only affects linkage. It does NOT change compilation rules — code inside `extern "C"` is still compiled as C++ and must be valid C++.

---

## Why You Cannot Use an `extern "C"` Bridge File

A common but **broken** approach is creating a `.cpp` file that `#include`s all the `.c` files inside an `extern "C"` block:

```cpp
// aubio_bridge.cpp — DO NOT DO THIS
extern "C" {
#include "aubio/fvec.c"
#include "aubio/spectral/fft.c"
#include "aubio/onset/onset.c"
// ...
}
```

This fails for multiple reasons:

### 1. C++ Keywords Used as Identifiers in C Code

C code can legally use words like `new`, `class`, `template`, `delete`, `this`, and `namespace` as variable or parameter names. C++ reserves these as keywords. For example, aubio's `phasevoc.c` had:

```c
static void aubio_pvoc_swapbuffers(aubio_pvoc_t *pv, const fvec_t *new)
{
    smpl_t *datanew = new->data;  // 'new' is a C++ keyword!
}
```

This is valid C but a syntax error in C++, even inside `extern "C"`.

### 2. System Headers Pull in C++ Templates

On modern Apple SDKs (iOS 26+), C system headers like `<Accelerate/Accelerate.h>` can transitively include C++ standard library headers (`<complex>`, `<tuple>`, etc.). These headers contain `template` declarations, which are illegal inside an `extern "C"` block:

```
error: templates must have C++ linkage
```

### 3. Implicit `void*` Casts

C allows implicit conversion from `void*` to any pointer type. C++ does not. Code like `smpl_t *p = malloc(n)` compiles in C but fails in C++. While aubio uses cast macros (`AUBIO_NEW`, `AUBIO_ARRAY`) that handle this, not all C libraries will.

### The Correct Approach

Let CocoaPods compile the `.c` files as plain C. Add them to `source_files` in the podspec:

```ruby
s.source_files = [
  "cpp/**/*.{hpp,cpp}",
  "cpp/aubio/**/*.{h,c}",   # Compiled as C by the build system
]
```

Each `.c` file becomes a separate C compilation unit. C linkage is automatic. No `extern "C"` wrapper needed. No C/C++ incompatibilities.

---

## C Code That Breaks Under C++ Compilation

If you're vendoring a C library and it MUST be compiled as C++ for some reason (not recommended), audit for these patterns:

| C Pattern | C++ Problem | Fix |
|---|---|---|
| `int new = 0;` | `new` is a keyword | Rename to `new_val` |
| `void *p = malloc(n); int *q = p;` | No implicit `void*` cast | Add explicit cast: `(int*)p` |
| `int class = 1;` | `class` is a keyword | Rename to `klass` |
| `typedef struct { ... } foo_t;` | Can't forward-declare anonymous struct typedefs | Include the real header |

If you find C++ keywords used as identifiers (like the `new` example in aubio's `phasevoc.c`), you'll need to patch the vendored source:

```c
// Before (valid C, invalid C++)
static void swapbuffers(pv_t *pv, const fvec_t *new);

// After
static void swapbuffers(pv_t *pv, const fvec_t *newbuf);
```

---

## Forward Declarations vs. Real Includes

### The Problem with Forward Declarations

You might try to avoid including C headers in your `.hpp` by using forward declarations:

```cpp
// Seems reasonable, but WRONG for aubio's fvec_t
typedef struct _fvec_t fvec_t;
```

This creates a typedef where `fvec_t` = `struct _fvec_t`. But aubio defines `fvec_t` as:

```c
typedef struct {
    uint_t length;
    smpl_t *data;
} fvec_t;
```

This is an **anonymous struct** — there is no `struct _fvec_t`. When the compiler sees both declarations, it reports:

```
error: typedef redefinition with different types
```

### When Forward Declarations DO Work

Forward declarations work when the C library uses **named struct tags**:

```c
// In the C library's header:
typedef struct _aubio_onset_t aubio_onset_t;

// Your forward declaration (compatible):
typedef struct _aubio_onset_t aubio_onset_t;  // OK — same struct tag
```

### The Safe Approach

Include the actual C headers in your `.hpp` wrapped in `extern "C"`. Since `HybridChordDSP.hpp` is a **private** header (not in `public_header_files`), it won't interfere with the Clang module system:

```cpp
extern "C" {
#include "aubio/types.h"   // uint_t, smpl_t
#include "aubio/fvec.h"    // fvec_t (anonymous struct)
#include "aubio/onset/onset.h"  // aubio_onset_t (named struct)
}
```

---

## The Expo Config Plugin

For Expo projects, you need a config plugin to add the pod to the Podfile. Keep it minimal — no post_install hacks are needed when the podspec is correct:

```javascript
// plugins/withChordDSP.js
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

function withChordDSP(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const podfilePath = path.join(
        config.modRequest.platformProjectRoot,
        "Podfile",
      );
      let podfile = fs.readFileSync(podfilePath, "utf-8");

      const podLine = `  pod 'NitroChordDsp', :path => '../modules/chord-dsp'`;
      if (!podfile.includes("NitroChordDsp")) {
        podfile = podfile.replace(
          "use_expo_modules!",
          `use_expo_modules!\n${podLine}`,
        );
      }

      fs.writeFileSync(podfilePath, podfile);
      return config;
    },
  ]);
}

module.exports = withChordDSP;
```

Register it in `app.json` / `app.config.js`:

```json
{
  "plugins": ["./plugins/withChordDSP"]
}
```

---

## What NOT to Do

These are approaches that were attempted and failed during this integration:

### 1. Do NOT Modify Umbrella Headers in post_install

Wrapping C++ `#import`s in `#ifdef __cplusplus` guards in the CocoaPods-generated umbrella header **breaks Swift/C++ interop**. The Clang module system does not define `__cplusplus` when building modules for Swift, so the C++ headers get excluded and Swift can't see the C++ namespaces.

### 2. Do NOT Remove `module * { export * }` from Modulemaps

This directive creates submodules from the umbrella header. Removing it prevents the module system from properly exposing types.

### 3. Do NOT Add `requires cplusplus` to Modulemaps

While this seems logical, it causes hard errors for development pods (whose modulemaps are copied to `Pods/Headers/Public/`) and also fails during Swift module compilation. Clang reports:

```
module 'NitroChordDsp' requires feature 'cplusplus'
```

### 4. Do NOT Create a Custom `.modulemap` File in the Source Directory

CocoaPods auto-generates modulemaps when `DEFINES_MODULE = YES`. A custom modulemap in your module's source directory conflicts with the auto-generated one, breaking the module resolution chain.

### 5. Do NOT Set `pod_target_xcconfig` After `add_nitrogen_files()`

This is the single most subtle and damaging mistake. It silently destroys nitrogen's build settings with no warning.

---

## Quick Checklist

When adding a vendored C library to a Nitro module:

- [ ] Place C source under `cpp/<library>/`
- [ ] Add `"cpp/<library>/**/*.{h,c}"` to `source_files` in the podspec
- [ ] Set `HEADER_SEARCH_PATHS` to the library's root (with `$(inherited)`)
- [ ] Set any required `GCC_PREPROCESSOR_DEFINITIONS` (with `$(inherited)`)
- [ ] All of the above **BEFORE** `add_nitrogen_files(s)` in the podspec
- [ ] Link any required frameworks (`s.frameworks = "Accelerate"`)
- [ ] Use `extern "C" { #include "..." }` in `.hpp` headers for C type includes
- [ ] If the library's umbrella header has `#ifdef __cplusplus` guards, include directly in `.cpp`
- [ ] Audit C source for C++ keyword conflicts (`new`, `class`, `template`, etc.) — patch if needed
- [ ] Do NOT forward-declare anonymous struct typedefs — include the real header
- [ ] Do NOT create bridge `.cpp` files that `#include` `.c` files inside `extern "C"`
- [ ] Do NOT create custom `.modulemap` files
- [ ] Do NOT modify CocoaPods-generated umbrella headers or modulemaps
- [ ] Keep the Expo config plugin minimal (pod declaration only, no post_install hacks)
