const fs = require('fs');
const { LineBuffer } = require('./logic');

/** Reads the events Unity has appended to an NDJSON file since the last poll. */
class EventTail {
    constructor(filePath) {
        this.filePath = filePath;
        this.lines = new LineBuffer();
        this.offset = 0;
    }

    poll() {
        if (!fs.existsSync(this.filePath)) return [];
        const size = fs.statSync(this.filePath).size;
        if (size <= this.offset) return [];
        const chunk = Buffer.alloc(size - this.offset);
        const handle = fs.openSync(this.filePath, 'r');
        fs.readSync(handle, chunk, 0, chunk.length, this.offset);
        fs.closeSync(handle);
        this.offset = size;
        return this.lines.push(chunk).map(line => JSON.parse(line));
    }
}

module.exports = { EventTail };
