"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.readBlockMap = exports.DifferentialDownloader = void 0;

function _bluebirdLst() {
  const data = _interopRequireWildcard(require("bluebird-lst"));

  _bluebirdLst = function () {
    return data;
  };

  return data;
}

function _builderUtilRuntime() {
  const data = require("builder-util-runtime");

  _builderUtilRuntime = function () {
    return data;
  };

  return data;
}

function _fsExtraP() {
  const data = require("fs-extra-p");

  _fsExtraP = function () {
    return data;
  };

  return data;
}

function _DataSplitter() {
  const data = require("./DataSplitter");

  _DataSplitter = function () {
    return data;
  };

  return data;
}

function _downloadPlanBuilder() {
  const data = require("./downloadPlanBuilder");

  _downloadPlanBuilder = function () {
    return data;
  };

  return data;
}

function _multipleRangeDownloader() {
  const data = require("./multipleRangeDownloader");

  _multipleRangeDownloader = function () {
    return data;
  };

  return data;
}

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = Object.defineProperty && Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : {}; if (desc.get || desc.set) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; return newObj; } }

const inflateRaw = _bluebirdLst().default.promisify(require("zlib").inflateRaw);

class DifferentialDownloader {
  // noinspection TypeScriptAbstractClassConstructorCanBeMadeProtected
  constructor(blockAwareFileInfo, httpExecutor, options) {
    this.blockAwareFileInfo = blockAwareFileInfo;
    this.httpExecutor = httpExecutor;
    this.options = options;
    this.fileMetadataBuffer = null;
    this.logger = options.logger;
    this.baseRequestOptions = (0, _builderUtilRuntime().configureRequestOptionsFromUrl)(options.newUrl, {});
  }

  createRequestOptions(method = "get", newUrl) {
    return Object.assign({}, newUrl == null ? this.baseRequestOptions : (0, _builderUtilRuntime().configureRequestOptionsFromUrl)(newUrl, {}), {
      method,
      headers: Object.assign({}, this.options.requestHeaders, {
        accept: "*/*"
      })
    });
  }

  doDownload(oldBlockMap, newBlockMap) {
    // we don't check other metadata like compressionMethod - generic check that it is make sense to differentially update is suitable for it
    if (oldBlockMap.version !== newBlockMap.version) {
      throw new Error(`version is different (${oldBlockMap.version} - ${newBlockMap.version}), full download is required`);
    }

    const logger = this.logger;
    const operations = (0, _downloadPlanBuilder().computeOperations)(oldBlockMap, newBlockMap, logger);

    if (logger.debug != null) {
      logger.debug(JSON.stringify(operations, null, 2));
    }

    let downloadSize = 0;
    let copySize = 0;

    for (const operation of operations) {
      const length = operation.end - operation.start;

      if (operation.kind === _downloadPlanBuilder().OperationKind.DOWNLOAD) {
        downloadSize += length;
      } else {
        copySize += length;
      }
    }

    const newPackageSize = this.blockAwareFileInfo.size;

    if (downloadSize + copySize + (this.fileMetadataBuffer == null ? 0 : this.fileMetadataBuffer.length) !== newPackageSize) {
      throw new Error(`Internal error, size mismatch: downloadSize: ${downloadSize}, copySize: ${copySize}, newPackageSize: ${newPackageSize}`);
    }

    logger.info(`Full: ${formatBytes(newPackageSize)}, To download: ${formatBytes(downloadSize)} (${Math.round(downloadSize / (newPackageSize / 100))}%)`);
    return this.downloadFile(operations);
  }

  downloadFile(tasks) {
    const fdList = [];

    const closeFiles = () => {
      return _bluebirdLst().default.map(fdList, openedFile => {
        return (0, _fsExtraP().close)(openedFile.descriptor).catch(e => {
          this.logger.error(`cannot close file "${openedFile.path}": ${e}`);
        });
      });
    };

    return this.doDownloadFile(tasks, fdList).then(closeFiles).catch(e => {
      // then must be after catch here (since then always throws error)
      return closeFiles().catch(closeFilesError => {
        // closeFiles never throw error, but just to be sure
        try {
          this.logger.error(`cannot close files: ${closeFilesError}`);
        } catch (errorOnLog) {
          try {
            console.error(errorOnLog);
          } catch (ignored) {// ok, give up and ignore error
          }
        }

        throw e;
      }).then(() => {
        throw e;
      });
    });
  }

  doDownloadFile(tasks, fdList) {
    var _this = this;

    return (0, _bluebirdLst().coroutine)(function* () {
      const oldFileFd = yield (0, _fsExtraP().open)(_this.options.oldFile, "r");
      fdList.push({
        descriptor: oldFileFd,
        path: _this.options.oldFile
      });
      const newFileFd = yield (0, _fsExtraP().open)(_this.options.newFile, "w");
      fdList.push({
        descriptor: newFileFd,
        path: _this.options.newFile
      });
      const fileOut = (0, _fsExtraP().createWriteStream)(_this.options.newFile, {
        fd: newFileFd
      });
      yield new Promise((resolve, reject) => {
        const streams = [];
        const digestTransform = new (_builderUtilRuntime().DigestTransform)(_this.blockAwareFileInfo.sha512); // to simply debug, do manual validation to allow file to be fully written

        digestTransform.isValidateOnEnd = false;
        streams.push(digestTransform); // noinspection JSArrowFunctionCanBeReplacedWithShorthand

        fileOut.on("finish", () => {
          fileOut.close(() => {
            try {
              digestTransform.validate();
            } catch (e) {
              reject(e);
              return;
            }

            resolve();
          });
        });
        streams.push(fileOut);
        let lastStream = null;

        for (const stream of streams) {
          stream.on("error", reject);

          if (lastStream == null) {
            lastStream = stream;
          } else {
            lastStream = lastStream.pipe(stream);
          }
        }

        const firstStream = streams[0];
        let w;

        if (_this.options.useMultipleRangeRequest) {
          w = (0, _multipleRangeDownloader().executeTasks)(_this, tasks, firstStream, oldFileFd, reject);
        } else {
          let attemptCount = 0;
          let actualUrl = null;

          _this.logger.info(`Differential download: ${_this.options.newUrl}`);

          w = index => {
            if (index >= tasks.length) {
              if (_this.fileMetadataBuffer != null) {
                firstStream.write(_this.fileMetadataBuffer);
              }

              firstStream.end();
              return;
            }

            const operation = tasks[index++];

            if (operation.kind === _downloadPlanBuilder().OperationKind.COPY) {
              (0, _DataSplitter().copyData)(operation, firstStream, oldFileFd, reject, () => w(index));
            } else {
              const requestOptions = _this.createRequestOptions("get", actualUrl);

              const range = `bytes=${operation.start}-${operation.end - 1}`;
              requestOptions.headers.Range = range;
              requestOptions.redirect = "manual";
              const debug = _this.logger.debug;

              if (debug != null) {
                debug(`effective url: ${actualUrl == null ? "original" : removeQuery(actualUrl)}, range: ${range}`);
              }

              const request = _this.httpExecutor.doRequest(requestOptions, response => {
                // Electron net handles redirects automatically, our NodeJS test server doesn't use redirects - so, we don't check 3xx codes.
                if (response.statusCode >= 400) {
                  reject((0, _builderUtilRuntime().createHttpError)(response));
                }

                response.pipe(firstStream, {
                  end: false
                });
                response.once("end", () => {
                  if (++attemptCount === 100) {
                    attemptCount = 0;
                    setTimeout(() => w(index), 1000);
                  } else {
                    w(index);
                  }
                });
              });

              request.on("redirect", (statusCode, method, redirectUrl) => {
                _this.logger.info(`Redirect to ${removeQuery(redirectUrl)}`);

                actualUrl = redirectUrl;
                request.followRedirect();
              });

              _this.httpExecutor.addErrorAndTimeoutHandlers(request, reject);

              request.end();
            }
          };
        }

        w(0);
      });
    })();
  }

  readRemoteBytes(start, endInclusive) {
    var _this2 = this;

    return (0, _bluebirdLst().coroutine)(function* () {
      const buffer = Buffer.allocUnsafe(endInclusive + 1 - start);

      const requestOptions = _this2.createRequestOptions();

      requestOptions.headers.Range = `bytes=${start}-${endInclusive}`;
      let position = 0;
      yield _this2.request(requestOptions, chunk => {
        chunk.copy(buffer, position);
        position += chunk.length;
      });
      return buffer;
    })();
  }

  request(requestOptions, dataHandler) {
    return new Promise((resolve, reject) => {
      const request = this.httpExecutor.doRequest(requestOptions, response => {
        if (!(0, _multipleRangeDownloader().checkIsRangesSupported)(response, reject)) {
          return;
        }

        response.on("data", dataHandler);
        response.on("end", () => resolve());
      });
      this.httpExecutor.addErrorAndTimeoutHandlers(request, reject);
      request.end();
    });
  }

}

exports.DifferentialDownloader = DifferentialDownloader;

let readBlockMap = (() => {
  var _ref = (0, _bluebirdLst().coroutine)(function* (data) {
    return JSON.parse((yield inflateRaw(data)).toString());
  });

  return function readBlockMap(_x) {
    return _ref.apply(this, arguments);
  };
})();

exports.readBlockMap = readBlockMap;

function formatBytes(value, symbol = " KB") {
  return new Intl.NumberFormat("en").format((value / 1024).toFixed(2)) + symbol;
} // safety


function removeQuery(url) {
  const index = url.indexOf("?");
  return index < 0 ? url : url.substring(0, index);
} 
//# sourceMappingURL=DifferentialDownloader.js.map