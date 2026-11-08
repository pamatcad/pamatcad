include(FetchContent)
set(PAMATCAD_OCCT_VERSION 8.0.1)
string(REPLACE "." "_" occt_tag "${PAMATCAD_OCCT_VERSION}")
FetchContent_Declare(occt
  URL https://codeload.github.com/Open-Cascade-SAS/OCCT/tar.gz/refs/tags/V${occt_tag}
  URL_HASH SHA256=0d6913eae4bcc09a3653ceced6dda1aec11c35a1513d4c06762c9b002092c68a
  TIMEOUT 120
  INACTIVITY_TIMEOUT 20
  DOWNLOAD_EXTRACT_TIMESTAMP FALSE
  SOURCE_SUBDIR unused)
FetchContent_MakeAvailable(occt)

