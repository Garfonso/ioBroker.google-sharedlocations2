import type { User } from './User';

/**
 * Geofence class
 */
export class Fence {
    name: string;
    lat: number;
    long: number;
    radius: number;
    user: string;
    fenceId: string;
    valid: boolean = true;

    /**
     * Constructor
     *
     * @param name of the fence
     * @param lat of the fence center
     * @param long of the fence center
     * @param radius in meters
     * @param user user id to check
     * @param fenceId iobroker state id to set
     */
    constructor(name: string, lat: number, long: number, radius: number, user: string, fenceId: string) {
        this.name = name;
        this.lat = lat;
        this.long = long;
        this.radius = radius;
        this.user = user;
        this.fenceId = fenceId;
        this.valid = !!(lat && long && radius > 0 && user && fenceId);
    }

    private toRadians(degrees: number): number {
        return degrees * (Math.PI / 180);
    }

    private haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371000; // Earth radius in meters
        const dLat = this.toRadians(lat2 - lat1);
        const dLon = this.toRadians(lon2 - lon1);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Check if a point is inside the fence.
     *
     * @param user to check
     */
    isInsideFence(user: User): boolean {
        if (this.valid && user.id && user.lat && user.long) {
            const distance = this.haversineDistance(this.lat, this.long, user.lat, user.long);
            return distance <= this.radius;
        }
        return false;
    }
}
