# Older Changes
## 0.3.1 (2026-02-09)
* (Garfonso) improved logging during login.
* (Garfonso) handle situation where browser logs in with his cookie, so we only need to read the cookie.

## 0.3.0 (2026-02-09)
* (Garfonso) do not update states if no new position is available.
* (Garfonso) fixed: refresh via browser
* (Garfonso) added: force refresh via browser by setting "forceRefresh" state to true
* (Garfonso) changed: now store complete cookies array

## 0.2.0 (2026-02-03)
* (Garfonso) now using data directory to store chrome data
* (Garfonso) try to use existing cookie in browser to refresh cookie without login.

## 0.1.1 (2026-02-02)
* (Garfonso) improved recovery from login errors

## 0.1.0 (2026-02-02)
* (Garfonso) added: support for places
* (Garfonso) added: support for fences
* (Garfonso) try to prevent login as much as possible.

## 0.0.3 (2026-01-28)
* (Garfonso) prevent login if no username and password is set
* (Garfonso) fix tests

## 0.0.2 (2026-01-28)
* (Garfonso) store password encrypted
