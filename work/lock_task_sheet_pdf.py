from pathlib import Path
from secrets import token_urlsafe

from pypdf import PdfReader, PdfWriter
from pypdf.constants import UserAccessPermissions


root = Path(r"C:\Users\vince\OneDrive\Documents\tesda_capstone")
source = root / "work" / "task_sheet_render" / "Silent_Handover_Task_Sheet_6.1_Capstone_Proposal.pdf"
target = root / "outputs" / "Silent_Handover_Task_Sheet_6.1_Capstone_Proposal_Locked.pdf"

reader = PdfReader(source)
writer = PdfWriter()
writer.clone_document_from_reader(reader)
permissions = (
    UserAccessPermissions.PRINT
    | UserAccessPermissions.PRINT_TO_REPRESENTATION
    | UserAccessPermissions.EXTRACT
    | UserAccessPermissions.EXTRACT_TEXT_AND_GRAPHICS
)
writer.encrypt(
    user_password="",
    owner_password=token_urlsafe(36),
    permissions_flag=permissions,
    algorithm="AES-256",
)
with target.open("wb") as stream:
    writer.write(stream)

check = PdfReader(target)
if not check.is_encrypted:
    raise RuntimeError("PDF protection was not applied")
if check.decrypt("") == 0:
    raise RuntimeError("Locked PDF cannot be opened without a password")
if len(check.pages) != 4:
    raise RuntimeError(f"Expected 4 pages, found {len(check.pages)}")
print(target)
