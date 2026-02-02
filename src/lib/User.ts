/**
 * User class representing a user with location and info data.
 */
export class User {
    id: string | null;
    name?: string;
    photoURL?: string;
    lat?: number;
    long?: number;
    address?: string;
    battery?: number;
    timestamp?: number;
    accuracy?: number;

    /**
     * Creates a User instance from location data.
     *
     * @param locationData - Array containing user location and info data
     */
    constructor(locationData: Array<any>) {
        this.id = null;
        if (locationData && Array.isArray(locationData)) {
            // locationData present
            if (locationData[0] && locationData[0][0]) {
                this.id = locationData[0][0];
            }
            if (locationData[0] && locationData[0][1]) {
                this.photoURL = locationData[0][1];
            }
            if (locationData[0] && locationData[0][3]) {
                this.name = locationData[0][3];
            }
            if (locationData[1] && locationData[1][1] && locationData[1][1][2]) {
                this.lat = locationData[1][1][2];
            }
            if (locationData[1] && locationData[1][1] && locationData[1][1][1]) {
                this.long = locationData[1][1][1];
            }
            if (locationData[1] && locationData[1][4]) {
                this.address = locationData[1][4];
            }
            if (locationData[13] && locationData[13][1]) {
                this.battery = locationData[13][1];
            }
            if (locationData[1] && locationData[1][2]) {
                this.timestamp = locationData[1][2];
            }
            if (locationData[1] && locationData[1][3]) {
                this.accuracy = locationData[1][3];
            }
        }
    }
}
