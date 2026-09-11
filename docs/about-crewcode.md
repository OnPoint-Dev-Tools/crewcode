# About CrewCode

Open the CrewCode brand menu and select **About CrewCode** to see a compact app
identity card. It shows the running CrewCode version and build commit.

The app menu header, About card, and **Settings → Updates** all read the same
runtime build-info contract. Desktop builds use Electron's packaged app version;
browser clients read the version of the CrewCode server or Brain they are
connected to. The Hub relay classifies that metadata read under its existing
`workspace:read` scope. No version label is maintained separately in renderer
code.

The version advances through the normal release scripts, which update
`package.json`. Electron packages expose that value through `app.getVersion()`,
and headless entries receive the same package version at build time. An installed
update therefore reports its new version after CrewCode restarts into that build.
