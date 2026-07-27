# RoadSpeed maps

Builds an offline speed limit database for Finland from official road records,
and publishes it as a release so a phone can download it without an account or
an internet connection afterwards.

## What it contains

One SQLite file holding every drivable road in Finland with its speed limit,
direction of travel and simplified geometry. Around 95% of the limits are the
real posted values rather than assumptions, because they come from the national
road register rather than a crowd-sourced map.

Roads that carry no official limit and are private or lead only into a yard are
left out entirely, rather than being filled in with a guess. A missing answer is
more useful than a confident wrong one when the number is being shown to someone
who is driving.

## Where the data comes from

[Digiroad](https://vayla.fi/en/transport-network/data/digiroad), the national
road and street database maintained by Väylävirasto (the Finnish Transport
Infrastructure Agency), published as open data under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The build downloads one province at a time from the agency's open data portal,
converts it, and discards it before moving on, so the whole 5 GB release never
has to fit on disk at once.

Winter speed limits are modelled: Finland lowers 120 km/h to 100 and 100 km/h to
80 for the darker half of the year, and both values are stored so the correct one
can be shown for the current date.

## Building

Run the **Build Digiroad speed limit database** workflow from the Actions tab.
It publishes the database and a small `manifest.json` describing it. Nothing
needs to be configured and no secrets are required.

The converter is plain Node with no native dependencies beyond SQLite, and its
tests run with `npm test` in `tools/build-speeddb`.

## Attribution

Contains data from Digiroad © Väylävirasto, licensed under CC BY 4.0.
The database is a derived work and carries the same licence.
