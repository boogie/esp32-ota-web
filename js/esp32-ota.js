function wait(ms) {
    return new Promise(resolve => {
        setTimeout(() => { resolve() }, ms);
    });
}

class ESP32OTA {
    constructor(di = {}) {
        this.UART_SERVICE_UUID = 'fb1e4001-54ae-4a28-9f74-dfccb248601d';
        this.UART_RX_CHAR_UUID = 'fb1e4002-54ae-4a28-9f74-dfccb248601d';
        this.UART_TX_CHAR_UUID = 'fb1e4003-54ae-4a28-9f74-dfccb248601d';
        this._mtu = 200;
        this._partSize = 16384;
        this._device = null;
        this._service = null;
        this._characteristicRx = null;
        this._characteristicTx = null;
        this._connectCallback = null;
        this._connectingCallback = null;
        this._disconnectCallback = null;
        this._messageCallback = null;
        this._imageUploadProgressCallback = null;
        this._uploadIsInProgress = false;
        this._logger = di.logger || { info: console.log, error: console.error };
        this._userRequestedDisconnect = false;
    }
    async _requestDevice(filters) {
        const params = {
            acceptAllDevices: true,
            optionalServices: [this.UART_SERVICE_UUID]
        };
        if (filters) {
            params.filters = filters;
            params.acceptAllDevices = false;
        }
        return navigator.bluetooth.requestDevice(params);
    }
    async connect(filters) {
        try {
            this._device = await this._requestDevice(filters);
            this._logger.info(`Connecting to device ${this.name}...`);
            this._device.addEventListener('gattserverdisconnected', async event => {
                this._logger.info(event);
                if (!this._userRequestedDisconnect) {
                    this._logger.info('Trying to reconnect');
                    this._connect(1000);
                } else {
                    this._disconnected();
                }
            });
            this._connect(0);
        } catch (error) {
            this._logger.error(error);
            await this._disconnected();
            return;
        }
    }
    _connect() {
        setTimeout(async () => {
            try {
                if (this._connectingCallback) this._connectingCallback();
                const server = await this._device.gatt.connect();
                this._logger.info(`Server connected.`);
                this._service = await server.getPrimaryService(this.UART_SERVICE_UUID);
                this._logger.info(`Service connected.`);
                this._characteristicRx = await this._service.getCharacteristic(this.UART_RX_CHAR_UUID);
                this._characteristicTx = await this._service.getCharacteristic(this.UART_TX_CHAR_UUID);
                this._characteristicTx.addEventListener('characteristicvaluechanged', this._notification.bind(this));
                await this._characteristicTx.startNotifications();
                await this._connected();
                if (this._uploadIsInProgress) {
                    this._uploadNext();
                }
            } catch (error) {
                this._logger.error(error);
                await this._disconnected();
            }
        }, 1000);
    }
    disconnect() {
        this._userRequestedDisconnect = true;
        return this._device.gatt.disconnect();
    }
    onConnecting(callback) {
        this._connectingCallback = callback;
        return this;
    }
    onConnect(callback) {
        this._connectCallback = callback;
        return this;
    }
    onDisconnect(callback) {
        this._disconnectCallback = callback;
        return this;
    }
    onMessage(callback) {
        this._messageCallback = callback;
        return this;
    }
    onImageUploadProgress(callback) {
        this._imageUploadProgressCallback = callback;
        return this;
    }
    onImageUploadFinished(callback) {
        this._imageUploadFinishedCallback = callback;
        return this;
    }
    async _connected() {
        if (this._connectCallback) this._connectCallback();
    }
    async _disconnected() {
        this._logger.info('Disconnected.');
        if (this._disconnectCallback) this._disconnectCallback();
        this._device = null;
        this._service = null;
        this._characteristicTx = null;
        this._characteristicRx = null;
        this._uploadIsInProgress = false;
        this._userRequestedDisconnect = false;
    }
    get name() {
        return this._device && this._device.name;
    }
    async _sendMessage(cmd, data) {
        const message = [cmd, ...data];
        console.log('>' + message.map(x => x.toString(16).padStart(2, '0')).join(' '));
        return await this._characteristicRx.writeValueWithoutResponse(Uint8Array.from(message));
    }
    async _notification(event) {
        console.log('message received');
        const message = new Uint8Array(event.target.value.buffer);
        // console.log(message);
        console.log('<' + [...message].map(x => x.toString(16).padStart(2, '0')).join(' '));
        const [cmd, ...data] = message;
        if (cmd === 0xAA) {
            const mode = data[0];
            console.log(`Transfer mode: ${mode}`);
            if (mode === 0) { // normal mode
                await this._uploadNext(0);
            }
            if (mode === 1) { // fast mode
                for (let part = 0; part < this._fileParts; part++) {
                    await this._uploadNext(part);
                }
            }
        }
        if (cmd === 0xF1) {
            const nextPart = data[0] * 256 + data[1];
            await this._uploadNext(nextPart);
        }
        if (cmd === 0xF2) {
            console.log('Installing firmware...');
            this._uploadIsInProgress = false;
            this._imageUploadFinishedCallback();
        }
        if (cmd === 0x0F) {
            const result = data.map(chr => String.fromCharCode(chr)).join('');
            console.log('OTA result: ' + result);
            alert(result);
        }
        if (this._messageCallback) this._messageCallback({ cmd, data });
    }
    async _uploadInit() {
        const fileLen = this._uploadImage.byteLength;
        const fileParts = Math.ceil(fileLen / this._partSize);

        await this._sendMessage(0xFD, []); // remove update.bin
        await this._sendMessage(0xFE, [fileLen >> 24 & 0xFF, fileLen >> 16 & 0xFF, fileLen >> 8 & 0xFF, fileLen & 0xFF]); // file size
        await this._sendMessage(0xFF, [fileParts >> 8, fileParts % 256, this._mtu >> 8, this._mtu % 256]); // ota info
    }
    async _uploadNext(part) {
        console.log(`PART: ${part}`);
        const fileLen = this._uploadImage.byteLength;
        const fileParts = Math.ceil(fileLen / this._partSize);
        this._imageUploadProgressCallback({ percentage: Math.floor(part / fileParts * 100) });

        const start = part * this._partSize;
        let end = start + this._partSize;
        if (fileLen < end) end = fileLen;

        const pieces = Math.ceil((end - start) / this._mtu);
        console.log(`pieces: ${pieces}`);
        for (let piece = 0; piece < pieces; piece++) {
            const pieceStart = start + piece * this._mtu;
            let pieceEnd = pieceStart + this._mtu;
            if (end < pieceEnd) pieceEnd = end;
            console.log(`piece #${piece}: ${pieceStart} - ${pieceEnd}`);
            const data = [piece, ...new Uint8Array(this._uploadImage.slice(pieceStart, pieceEnd))];
            await this._sendMessage(0xFB, data);
            await wait(5);
        }

        const data = [(end - start) >> 8, (end - start) % 256, part >> 8, part % 256];
        await this._sendMessage(0xFC, data); // write with response?
    }
    async cmdUpload(image) {
        if (this._uploadIsInProgress) {
            this._logger.error('Upload is already in progress.');
            return;
        }
        this._uploadIsInProgress = true;
        this._uploadImage = image;

        await this._uploadInit();
    }
    async imageInfo(image) {
        // https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/firmware-image-format.html

        const info = {};
        const view = new Uint8Array(image);

        // check header length
        if (view.length < 32) {
            throw new Error('Invalid image (too short file)');
        }

        // check MAGIC bytes 0xe9
        if (view[0] !== 0xe9) {
            throw new Error('Invalid image (wrong magic bytes)');
        }

        if (view[2] > 4) {
            throw new Error('Invalid image (wrong SPI Flash mode)');
        }

        const flashSize = view[3] >> 4;
        const flashSizes = ['1MB', '2MB', '4MB', '8MB', '16MB'];
        if (flashSize > 5) {
            throw new Error('Invalid Flash size');
        }
        info.flashSize = flashSizes[flashSize];

        const flashFreq = view[3] % 16;
        const flashFreqs = ['40MHz', '26MHz', '20MHz', , , , , , , , , , , , , '80MHz'];
        if (flashFreq > 2 && flashFreq != 15) {
            throw new Error('Invalid Flash frequency');
        }
        info.flashFreq = flashFreqs[flashFreq];

        return info;
    }
}

