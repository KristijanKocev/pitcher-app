#include <jni.h>
#include "NitroChordDspOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return margelo::nitro::chorddsp::initialize(vm);
}
