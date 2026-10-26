# Bundled sRGB ICC profile

`srgb-lcms216.icc` was generated locally with Pillow 10.3.0 / Little CMS 2.16:

```python
from PIL import ImageCms
profile = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB'))
open('srgb-lcms216.icc', 'wb').write(profile.tobytes())
```

588 bytes; SHA-256 `c792eb7d04fd81c4bb37a20f852efd02c8b8490c730f42d31b943226587c633f`.
The generated profile's copyright tag states `No copyright, use freely`.
This is generated numerical profile data, not a copy of Little CMS source or
an operating-system profile. Little CMS/Pillow are not runtime dependencies.
The ICC binary is pinned, not regenerated during installation (its creation
header time otherwise changes). Runtime verifies its hash before embedding.

Generation implementation reference:
https://github.com/mm2/Little-CMS/blob/lcms2.16/src/cmsvirt.c
(`cmsCreate_sRGBProfile`, `SetTextTags`). PNG declaration reference:
https://www.w3.org/TR/png-3/#11sRGB

The profile expresses the sRGB piecewise transfer curve and primaries; it is
not a simple gamma-2.2 replacement. Gray sRGB code values are replicated into
RGB channels without quantization or changing the alpha plane. Final output
still depends on the PDF viewer/output device; no printer/journal certification
or PDF/A/PDF/X conformance is claimed.
