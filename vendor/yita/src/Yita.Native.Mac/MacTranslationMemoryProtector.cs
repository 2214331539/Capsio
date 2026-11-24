using System.Security.Cryptography;
using Yita.Core.Platform;
using Yita.Translation;

namespace Yita.Native.Mac;

internal static class MacTranslationMemoryProtector
{
    internal const string KeyAccount = "translation-memory-key-v1";

    internal static Task<ITranslationMemoryProtector> CreateAsync(bool allowCreate,
        CancellationToken cancellationToken = default, IMacKeychainAccess? keychain = null) => Task.Run<ITranslationMemoryProtector>(() =>
    {
        cancellationToken.ThrowIfCancellationRequested();
        var store = keychain ?? new MacKeychainAccess();
        var key = store.Read(MacKeychainSecretStore.Service, KeyAccount);
        if (key is null && allowCreate)
        {
            var candidate = RandomNumberGenerator.GetBytes(32);
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (store.TryAdd(MacKeychainSecretStore.Service, KeyAccount, candidate)) key = candidate.ToArray();
                else key = store.Read(MacKeychainSecretStore.Service, KeyAccount);
            }
            finally { CryptographicOperations.ZeroMemory(candidate); }
        }
        if (key is null) throw new CryptographicException("The saved translation memory key is missing; existing data has been preserved.");
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            return new AesGcmTranslationMemoryProtector(key);
        }
        finally { CryptographicOperations.ZeroMemory(key); }
    }, cancellationToken);

    /// <summary>
    /// Inside Capsio the key is a file in Capsio's data folder that only the user can read.
    /// A keychain item asks for the login password again whenever the component's signature
    /// changes, which a rebuild can do.
    /// </summary>
    internal static Task<ITranslationMemoryProtector> CreateFromFileAsync(string keyPath, bool allowCreate,
        CancellationToken cancellationToken = default) => Task.Run<ITranslationMemoryProtector>(() =>
    {
        cancellationToken.ThrowIfCancellationRequested();
        var key = ReadKeyFile(keyPath);
        if (key is null && allowCreate)
        {
            var candidate = RandomNumberGenerator.GetBytes(32);
            var temporary = $"{keyPath}.{Guid.NewGuid():N}.tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(keyPath))!);
                using (var stream = new FileStream(temporary, new FileStreamOptions
                {
                    Mode = FileMode.CreateNew,
                    Access = FileAccess.Write,
                    UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
                }))
                {
                    stream.Write(candidate);
                    stream.Flush(true);
                }
                // Moving a whole file in place means a crash never leaves half a key behind.
                try { File.Move(temporary, keyPath, overwrite: false); key = candidate.ToArray(); }
                catch (IOException) when (File.Exists(keyPath)) { key = ReadKeyFile(keyPath); }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(candidate);
                File.Delete(temporary);
            }
        }
        if (key is null) throw new CryptographicException("The saved translation memory key is missing; existing data has been preserved.");
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            return new AesGcmTranslationMemoryProtector(key);
        }
        finally { CryptographicOperations.ZeroMemory(key); }
    }, cancellationToken);

    private static byte[]? ReadKeyFile(string path)
    {
        if (!File.Exists(path)) return null;
        var key = File.ReadAllBytes(path);
        if (key.Length == 32) return key;
        CryptographicOperations.ZeroMemory(key);
        return null;
    }
}
