/** 分块上传的单块字节数：客户端按它切文件，服务端按它校验，内存里始终只有一块。 */
export const IMPORT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
