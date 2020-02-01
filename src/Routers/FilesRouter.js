import express from 'express';
import BodyParser from 'body-parser';
import * as Middlewares from '../middlewares';
import Parse from 'parse/node';
import Config from '../Config';
import mime from 'mime';
import logger from '../logger';
const triggers = require('../triggers');
const http = require('http');

const downloadFileFromURI = (uri) => {
  return new Promise((res, rej) => {
    http.get(uri, (response) => {
      response.setDefaultEncoding('base64');
      let body = `data:${response.headers['content-type']};base64,`;
      response.on('data', data => body += data);
      response.on('end', () => res(body));
    }).on('error', (e) => {
      rej(`Error downloading file from ${uri}: ${e.message}`);
    });
  });
};

const addFileDataIfNeeded = async (file) => {
  if (file._source.format === 'uri') {
    const base64 = await downloadFileFromURI(file._source.uri);
    file._previousSave = file;
    file._data = base64;
    file._requestTask = null;
  }
  return file;
};

export class FilesRouter {
  expressRouter({ maxUploadSize = '20Mb' } = {}) {
    var router = express.Router();
    router.get('/files/:appId/:filename', this.getHandler);

    router.post('/files', function(req, res, next) {
      next(
        new Parse.Error(Parse.Error.INVALID_FILE_NAME, 'Filename not provided.')
      );
    });

    router.post(
      '/files/:filename',
      BodyParser.raw({
        type: () => {
          return true;
        },
        limit: maxUploadSize,
      }), // Allow uploads without Content-Type, or with any Content-Type.
      Middlewares.handleParseHeaders,
      this.createHandler
    );

    router.delete(
      '/files/:filename',
      Middlewares.handleParseHeaders,
      Middlewares.enforceMasterKeyAccess,
      this.deleteHandler
    );
    return router;
  }

  getHandler(req, res) {
    const config = Config.get(req.params.appId);
    const filesController = config.filesController;
    const filename = req.params.filename;
    const contentType = mime.getType(filename);
    if (isFileStreamable(req, filesController)) {
      filesController
        .handleFileStream(config, filename, req, res, contentType)
        .catch(() => {
          res.status(404);
          res.set('Content-Type', 'text/plain');
          res.end('File not found.');
        });
    } else {
      filesController
        .getFileData(config, filename)
        .then(data => {
          res.status(200);
          res.set('Content-Type', contentType);
          res.set('Content-Length', data.length);
          res.end(data);
        })
        .catch(() => {
          res.status(404);
          res.set('Content-Type', 'text/plain');
          res.end('File not found.');
        });
    }
  }

  async createHandler(req, res, next) {
    const config = req.config;
    const filesController = config.filesController;
    const { filename } = req.params;
    const contentType = req.get('Content-type');

    if (!req.body || !req.body.length) {
      next(
        new Parse.Error(Parse.Error.FILE_SAVE_ERROR, 'Invalid file upload.')
      );
      return;
    }

    const error = filesController.validateFilename(filename);
    if (error) {
      next(error);
      return;
    }

    const base64 = req.body.toString('base64');
    const file = new Parse.File(filename, { base64 }, contentType);
    const { metadata = {}, tags = {} } = req.fileData || {};
    file.setTags(tags);
    file.setMetadata(metadata);
    const fileSize = Buffer.byteLength(req.body);
    const fileObject = { file, fileSize };
    try {
      // run beforeSaveFile trigger
      const triggerResult = await triggers.maybeRunFileTrigger(
        triggers.Types.beforeSaveFile,
        fileObject,
        config,
        req.auth
      )
      let saveResult;
      // if a new ParseFile is returned check if it's an already saved file
      if (triggerResult instanceof Parse.File) {
        fileObject.file = triggerResult;
        if (triggerResult.url()) {
          // set fileSize to null because we wont know how big it is here
          fileObject.fileSize = null;
          saveResult = {
            url: triggerResult.url(),
            name: triggerResult._name,
          };
        }
      }
      // if the file returned by the trigger has already been saved skip saving anything
      if (!saveResult) {
        // if the ParseFile returned is type uri, download the file before saving it
        await addFileDataIfNeeded(fileObject.file);
        // update fileSize
        const bufferData = Buffer.from(fileObject.file._data, 'base64');
        fileObject.fileSize = Buffer.byteLength(bufferData);
        // save file
        const createFileResult = await filesController.createFile(
          config,
          fileObject.file._name,
          bufferData,
          fileObject.file._source.type,
          {
            tags: fileObject.file._tags,
            metadata: fileObject.file._metadata,
          }
        );
        // update file with new data
        fileObject.file._name = createFileResult.name;
        fileObject.file._url = createFileResult.url;
        fileObject.file._requestTask = null;
        fileObject.file._previousSave = Promise.resolve(fileObject.file);
        saveResult = {
          url: createFileResult.url,
          name: createFileResult.name,
        };
      }
      // run afterSaveFile trigger
      await triggers.maybeRunFileTrigger(
        triggers.Types.afterSaveFile,
        fileObject,
        config,
        req.auth
      );
      res.status(201);
      res.set('Location', saveResult.url);
      res.json(saveResult);

    } catch (e) {
      // TODO: Should the error message from a throw in beforeSaveFile hook be used here (instead of `Could not store file: ${filename}`)?
      logger.error('Error creating a file: ', e);
      next(
        new Parse.Error(
          Parse.Error.FILE_SAVE_ERROR,
          e.message ? e.message : `Could not store file: ${fileObject.file._name}.`
        )
      );
    }
  }

  async deleteHandler(req, res, next) {
    try {
      const { filesController } = req.config;
      const { filename } = req.params;
      // run beforeDeleteFile trigger
      const file = new Parse.File(filename);
      file._url = filesController.adapter.getFileLocation(req.config, filename);
      const fileObject = { file, fileSize: null }
      await triggers.maybeRunFileTrigger(
        triggers.Types.beforeDeleteFile,
        fileObject,
        req.config,
        req.auth
      );
      // delete file
      await filesController.deleteFile(req.config, filename);
      // run afterDeleteFile trigger
      await triggers.maybeRunFileTrigger(
        triggers.Types.afterDeleteFile,
        fileObject,
        req.config,
        req.auth
      );
      res.status(200);
      // TODO: return useful JSON here?
      res.end();
    } catch (e) {
      // TODO: Should the error message from a throw in beforeDeleteFile hook be used here (instead of 'Could not delete file')?
      logger.error('Error deleting a file: ', e);
      next(
        new Parse.Error(
          Parse.Error.FILE_DELETE_ERROR,
          'Could not delete file.'
        )
      );
    }
  }
}

function isFileStreamable(req, filesController) {
  return (
    req.get('Range') &&
    typeof filesController.adapter.handleFileStream === 'function'
  );
}
