import boto3
from botocore.config import Config
import uuid
from settings import settings

s3_client = boto3.client(
    "s3",
    endpoint_url=settings.S3_ENDPOINT,
    aws_access_key_id=f"{settings.S3_TENANT_ID}:{settings.S3_ACCESS_KEY}", 
    aws_secret_access_key=settings.S3_SECRET_KEY,
    config=Config(signature_version='s3v4')
)

def generate_presigned_url(folder: str, content_type: str) -> dict[str, str]:
    """Генерирует временную ссылку для прямой загрузки файла"""
    file_extension = content_type.split("/")[-1]
    if file_extension == "jpeg":
        file_extension = "jpg"
        
    object_name = f"{folder}/{uuid.uuid4()}.{file_extension}"
    

    presigned_url = s3_client.generate_presigned_url(
        ClientMethod='put_object',
        Params={
            'Bucket': settings.S3_BUCKET_NAME,
            'Key': object_name,
            'ContentType': content_type,
        },
        ExpiresIn=300
    )
    
    # domain_only = settings.S3_ENDPOINT.replace('https://', '').replace('http://', '').rstrip('/')
    # base_url = settings.S3_ENDPOINT.rstrip('/')
    public_url = f"https://global.s3.cloud.ru/{settings.S3_BUCKET_NAME}/{object_name}"
    
    return {
        "upload_url": presigned_url,
        "public_url": public_url
    }