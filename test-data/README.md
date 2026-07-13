# NearHome Test Data

This directory is intentionally ignored by Git. It contains downloaded video
fixtures and their derived MP4 clips, which must not be committed.

## Layout

- `ua-detrac/ua_detrac.mp4`: downloaded public traffic-video sample for
  vehicle detection and tracking (H.264, 960x540, 30 fps, 8.4 seconds).
- `mot17/`: pedestrian tracking sequences downloaded from MOTChallenge.
- `virat/`: stationary surveillance videos. Download only after accepting the
  VIRAT Ground Camera protection agreement.
- `animaltrack/`: animal tracking sequences. Download only after accepting the
  AnimalTrack research license.

## Dataset sources

- UA-DETRAC sample: `https://www.dropbox.com/s/k00wge9exwkfxz6/ua_detrac.mp4?raw=1`
- MOT17: `https://motchallenge.net/data/MOT17Det/`
- VIRAT: `https://viratdata.org/`
- AnimalTrack: `https://animaltrack.org/`

Treat downloaded datasets according to their upstream license and agreements.
