`generated-gray.icc` is generated numerical ICC fixture data from local Little
CMS (`cmsBuildGamma(NULL,2.2)`, `cmsCreateGrayProfile` with D50 xyY
0.3457/0.3585/1 and `cmsSaveProfileToMem`). Its own copyright tag says
`No copyright, use freely`. No source or OS profile was copied. The fixture
is used to assert native one-channel ICC/alpha PDF embedding, not shipped as
a production rendering profile. See runtime/color-profiles/README.md for the
Little CMS generator source reference.
